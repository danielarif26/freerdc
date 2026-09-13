import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  createEd25519Signer,
  ProcessManager,
  ResilientRpcWireAgent,
  SafeFilesystem,
} from '@freerdc/agent';
import { E_DEVICE_OFFLINE, FreeRdcError } from '@freerdc/protocol';
import { McpServer } from '@modelcontextprotocol/server';

import { DeviceRegistry } from '../src/device-registry.js';
import { createMcpHttpHost } from '../src/http-host.js';
import { WireHub } from '../src/wire-hub.js';

async function waitFor(check: () => boolean, message: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test('real reconnect offlines A, rejects its pending RPC, authenticates B, and never replays the old mutation', async () => {
  const pair = generateKeyPairSync('ed25519');
  const registry = new DeviceRegistry();
  const requestIds = ['old-request', 'new-request'];
  const hub = new WireHub({
    registry,
    authorizedKeys: new Map([['device-1', pair.publicKey]]),
    supportedCapabilities: ['fs.v1', 'proc.v1'],
    requestIdSource: () => requestIds.shift() ?? 'unexpected-request',
    requestTimeoutMs: 2_000,
  });

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'freerdc-reconnect-e2e-')));
  const marker = join(root, 'mutation-count.txt');
  const target = join(root, 'target.txt');
  writeFileSync(target, 'fresh-connection');

  const realNode = realpathSync(process.execPath);
  const processManager = new ProcessManager({
    roots: [root],
    policy: {
      rules: [{ executable: realNode, basename: basename(realNode), argv: (argv) => argv[0] === '-e' }],
    },
    limits: { maxCommandConcurrency: 1 },
  });
  const filesystem = new SafeFilesystem({ roots: [root] });
  const host = createMcpHttpHost(() => new McpServer({ name: 'reconnect-e2e', version: '0.0.0' }), 0, { hub });
  let agent: ResilientRpcWireAgent | undefined;

  try {
    const holder = await processManager.start({
      executable: realNode,
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: root,
    });

    const { port } = await host.start();
    agent = new ResilientRpcWireAgent({
      endpoint: `ws://127.0.0.1:${port}/agent`,
      deviceId: 'device-1',
      capabilities: ['fs.v1', 'proc.v1'],
      signer: createEd25519Signer(pair.privateKey),
      rpc: { filesystem, processManager, maxInFlight: 4 },
      initialReconnectDelayMs: 40,
      maxReconnectDelayMs: 40,
      reconnectMultiplier: 1,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 30_000,
    });
    agent.start();

    await waitFor(() => agent?.isReady === true && registry.get('device-1')?.status === 'online', 'connection A did not become ready');
    const connectorA = agent.connector;
    assert.ok(connectorA);

    const oldMutation = hub.request('device-1', 'proc.start', {
      executable: realNode,
      argv: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`],
      cwd: root,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    connectorA.close();

    await assert.rejects(
      oldMutation,
      (error: unknown) => error instanceof FreeRdcError && error.code === E_DEVICE_OFFLINE,
    );
    await waitFor(() => registry.get('device-1')?.status === 'offline', 'connection A was not marked offline');
    await waitFor(
      () => agent?.isReady === true && registry.get('device-1')?.status === 'online' && agent.connector !== connectorA,
      'connection B did not authenticate with a fresh connector',
    );

    const freshResult = await hub.request('device-1', 'fs.stat', { path: target }) as { type: string; size: number };
    assert.equal(freshResult.type, 'file');
    assert.equal(freshResult.size, Buffer.byteLength('fresh-connection'));

    assert.ok(processManager.kill(holder.id, true));
    await waitFor(
      () => processManager.list().find((item) => item.id === holder.id)?.status === 'exited',
      'holder process did not exit',
    );
    await waitFor(() => existsSync(marker), 'old mutation never completed on its original dispatcher');
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    assert.equal(readFileSync(marker, 'utf8'), 'x', 'old mutating request must execute at most once and must not replay on B');
    assert.equal(agent.isReady, true);
    assert.equal(registry.get('device-1')?.status, 'online');
  } finally {
    agent?.stop();
    processManager.killAll(true);
    await host.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
