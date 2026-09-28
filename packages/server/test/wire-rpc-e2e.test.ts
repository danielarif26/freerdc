import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import { createEd25519Signer, createRpcEnabledWireConnector, SafeFilesystem, ProcessManager, InMemoryStateProvider } from '@freerdc/agent';
import { E_PATH_ESCAPE, E_KILLSWITCH, E_TOO_LARGE, FreeRdcError, WIRE_MAX_FRAME_BYTES } from '@freerdc/protocol';
import { McpServer } from '@modelcontextprotocol/server';

import { DeviceRegistry } from '../src/device-registry.js';
import { createMcpHttpHost } from '../src/http-host.js';
import { WireHub } from '../src/wire-hub.js';
import { BACKPRESSURE_CLOSE_CODE, WireWsTransport } from '../src/wire-ws-transport.js';

type WireBytes = { encoding: 'utf8' | 'base64'; data: string };

function decodeWireBytes(wireBytes: WireBytes): Buffer {
  return Buffer.from(wireBytes.data, wireBytes.encoding);
}

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  const registry = new DeviceRegistry();
  const stateProvider = new InMemoryStateProvider();
  const hub = new WireHub({
    registry,
    authorizedKeys: new Map([['device-1', pair.publicKey]]),
    supportedCapabilities: ['fs.v1', 'proc.v1'],
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'freerdc-test-')));
  const outsideRoot = join(dirname(root), 'outside-root');
  const filesystem = new SafeFilesystem({
    roots: [root],
    stateProvider,
  });
  const realNode = realpathSync(process.execPath);
  const processManager = new ProcessManager({
    roots: [root],
    policy: {
      rules: [{
        executable: realNode,
        basename: basename(realNode),
        argv: (argv) => argv[0] === '-e'
      }]
    },
    stateProvider,
  });
  const host = createMcpHttpHost(() => new McpServer({ name: 'test-server', version: '0.0.0' }), 0, { hub });
  return { pair, registry, hub, host, root, outsideRoot, filesystem, processManager, stateProvider, realNode };
}

test('server sender enforces the exact frame cap and accounts queued frame bytes', () => {
  const sent: string[] = [];
  const closes: Array<number | undefined> = [];
  const transport = new WireWsTransport({
    readyState: 1,
    bufferedAmount: 0,
    send: (data) => sent.push(data),
    close: (code) => closes.push(code),
  });

  transport.send('x'.repeat(WIRE_MAX_FRAME_BYTES - 2));
  assert.equal(Buffer.byteLength(sent[0] ?? '', 'utf8'), WIRE_MAX_FRAME_BYTES);
  assert.throws(
    () => transport.send('x'.repeat(WIRE_MAX_FRAME_BYTES - 1)),
    (error: unknown) => error instanceof FreeRdcError && error.code === E_TOO_LARGE,
  );
  transport.send({ ok: true });
  assert.equal(sent.length, 2);
  assert.deepEqual(closes, []);

  const pressureCloses: Array<number | undefined> = [];
  const pressureTransport = new WireWsTransport({
    readyState: 1,
    bufferedAmount: 150,
    send: () => assert.fail('backpressured frame must not be sent'),
    close: (code) => pressureCloses.push(code),
  }, { bufferedAmountCeiling: 200 });
  assert.throws(() => pressureTransport.send({ payload: 'x'.repeat(64) }), /backpressure limit exceeded/);
  assert.deepEqual(pressureCloses, [BACKPRESSURE_CLOSE_CODE]);
});

test('filesystem/auth/security/kill-switch', async () => {
  const { pair, registry, hub, host, root, outsideRoot, filesystem, stateProvider } = fixture();
  let connector: ReturnType<typeof createRpcEnabledWireConnector>['connector'] | undefined;
  try {
    const { port } = await host.start();
    const endpoint = `ws://127.0.0.1:${port}/agent`;
    ({ connector } = createRpcEnabledWireConnector({
      endpoint,
      deviceId: 'device-1',
      capabilities: ['fs.v1'],
      signer: createEd25519Signer(pair.privateKey),
      rpc: { filesystem },
    }));
    await connector.connect();
    assert.equal(registry.get('device-1')?.status, 'online');

    // Test filesystem operations
    const insidePath = join(root, 'binary.bin');
    const outsidePath = join(outsideRoot, 'secret.txt');

    // Write a binary file
    const binaryData = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01]);
    writeFileSync(insidePath, binaryData);

    // Read the binary file
    const readResult = await hub.request('device-1', 'fs.read', { path: insidePath }) as { content: WireBytes };
    assert.deepEqual(decodeWireBytes(readResult.content), binaryData);

    // Write a text file
    const textData = 'Hello, world!';
    const textPath = join(root, 'text.txt');
    writeFileSync(textPath, textData);

    // Read the text file
    const textReadResult = await hub.request('device-1', 'fs.read', { path: textPath }) as { content: WireBytes };
    assert.deepEqual(decodeWireBytes(textReadResult.content), Buffer.from(textData, 'utf8'));

    // Test outside-root path
    await assert.rejects(
      hub.request('device-1', 'fs.stat', { path: outsidePath }),
      (error: unknown) => error instanceof FreeRdcError && error.code === E_PATH_ESCAPE && error.details === undefined
    );

    // Test kill-switch
    stateProvider.setActive(true);
    await assert.rejects(
      hub.request('device-1', 'fs.stat', { path: insidePath }),
      (error: unknown) => error instanceof FreeRdcError && error.code === E_KILLSWITCH && error.details === undefined
    );

    stateProvider.setActive(false);

    // Test fs.stat on textPath
    const statResult = await hub.request('device-1', 'fs.stat', { path: textPath }) as { type: string; size: number };
    const fsStat = statSync(textPath);
    assert.equal(statResult.type, 'file');
    assert.equal(statResult.size, fsStat.size);
  } finally {
    stateProvider.setActive(false);
    connector?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('oversized authenticated request is rejected without dropping the device connection', async () => {
  const { pair, registry, hub, host, root, filesystem, stateProvider } = fixture();
  let connector: ReturnType<typeof createRpcEnabledWireConnector>['connector'] | undefined;
  try {
    const { port } = await host.start();
    ({ connector } = createRpcEnabledWireConnector({
      endpoint: `ws://127.0.0.1:${port}/agent`,
      deviceId: 'device-1',
      capabilities: ['fs.v1'],
      signer: createEd25519Signer(pair.privateKey),
      rpc: { filesystem },
    }));
    await connector.connect();

    await assert.rejects(
      hub.request('device-1', 'fs.write', {
        path: join(root, 'oversized.txt'),
        content: { encoding: 'utf8', data: 'x'.repeat(300_000) },
      }),
      (error: unknown) => error instanceof FreeRdcError && error.code === E_TOO_LARGE,
    );
    assert.equal(registry.get('device-1')?.status, 'online');
    assert.equal(connector.isReady, true);

    const normalResult = await hub.request('device-1', 'fs.stat', { path: root }) as { type: string };
    assert.equal(normalResult.type, 'directory');
    assert.equal(registry.get('device-1')?.status, 'online');
    assert.equal(connector.isReady, true);
  } finally {
    stateProvider.setActive(false);
    connector?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('oversized authenticated response is rejected without dropping the device connection', async () => {
  const { pair, registry, hub, host, root, filesystem, stateProvider } = fixture();
  let connector: ReturnType<typeof createRpcEnabledWireConnector>['connector'] | undefined;
  try {
    writeFileSync(join(root, 'oversized.bin'), Buffer.alloc(200_000, 0xff));
    const { port } = await host.start();
    ({ connector } = createRpcEnabledWireConnector({
      endpoint: `ws://127.0.0.1:${port}/agent`,
      deviceId: 'device-1',
      capabilities: ['fs.v1'],
      signer: createEd25519Signer(pair.privateKey),
      rpc: { filesystem },
    }));
    await connector.connect();

    await assert.rejects(
      hub.request('device-1', 'fs.read', { path: join(root, 'oversized.bin') }),
      (error: unknown) => error instanceof FreeRdcError && error.code === E_TOO_LARGE,
    );
    assert.equal(registry.get('device-1')?.status, 'online');
    assert.equal(connector.isReady, true);

    const normalResult = await hub.request('device-1', 'fs.stat', { path: root }) as { type: string };
    assert.equal(normalResult.type, 'directory');
    assert.equal(registry.get('device-1')?.status, 'online');
    assert.equal(connector.isReady, true);
  } finally {
    stateProvider.setActive(false);
    connector?.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('safe process RPC', async () => {
  const { pair, registry, hub, host, root, processManager, realNode } = fixture();
  let connector: ReturnType<typeof createRpcEnabledWireConnector>['connector'] | undefined;
  try {
    const { port } = await host.start();
    const endpoint = `ws://127.0.0.1:${port}/agent`;
    ({ connector } = createRpcEnabledWireConnector({
      endpoint,
      deviceId: 'device-1',
      capabilities: ['fs.v1', 'proc.v1'],
      signer: createEd25519Signer(pair.privateKey),
      rpc: { filesystem: new SafeFilesystem({ roots: [root] }), processManager },
    }));
    await connector.connect();
    assert.equal(registry.get('device-1')?.status, 'online');

    // Test process start
    const startResult = await hub.request('device-1', 'proc.start', {
      executable: realNode,
      argv: ['-e', 'console.log("Hello, world!")'],
      cwd: root,
    }) as { id: string; status: string; startedAt: string };
    assert.ok(startResult.id);
    assert.equal(startResult.status, 'running');
    assert.equal('argv' in startResult, false);
    assert.equal('env' in startResult, false);
    assert.equal('executable' in startResult, false);

    // Test process read
    const stdoutChunks: WireBytes[] = [];
    const stderrChunks: WireBytes[] = [];
    let status: 'running' | 'exited' = 'running';
    let exitCode: number | null = null;
    let signal: string | null = null;
    let truncated = false;
    let hasMore = true;

    const start = Date.now();
    while (status !== 'exited' || hasMore) {
      if (Date.now() - start > 1500) throw new Error('proc.read timeout');
      const readResult = await hub.request('device-1', 'proc.read', { id: startResult.id }) as {
        stdout: WireBytes;
        stderr: WireBytes;
        truncated: boolean;
        hasMore: boolean;
        status: 'running' | 'exited';
        exitCode: number | null;
        signal: string | null;
      };
      stdoutChunks.push(readResult.stdout);
      stderrChunks.push(readResult.stderr);
      status = readResult.status;
      exitCode = readResult.exitCode;
      signal = readResult.signal;
      truncated = readResult.truncated;
      hasMore = readResult.hasMore;
      if (status !== 'exited' || hasMore) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    assert.equal(status, 'exited');
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    assert.equal(truncated, false);

    const stdout = Buffer.concat(stdoutChunks.map(chunk => decodeWireBytes(chunk)));
    assert.match(stdout.toString(), /Hello, world!/);

    const stderr = Buffer.concat(stderrChunks.map(chunk => decodeWireBytes(chunk)));
    assert.equal(stderr.length, 0);
  } finally {
    connector?.close();
    processManager.killAll(true);
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
