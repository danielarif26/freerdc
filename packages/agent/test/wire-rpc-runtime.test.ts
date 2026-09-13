import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { type ParsedEnvelope } from '@freerdc/protocol';
import { WebSocket } from 'ws';

import {
  createEd25519Signer,
  createRpcEnabledWireConnector,
  ProcessManager,
  SafeFilesystem,
  WireConnector,
  type CommandPolicy,
} from '../src/index.js';
import { decodeWireBytes, encodeWireBytes } from '../src/rpc/encoding.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code ?? 1000, Buffer.alloc(0));
  }

  terminate(): void {
    this.close();
  }
}

function envelope(kind: string, payload: unknown): unknown {
  return { v: 'freerdc-wire/1', id: `frame-${kind}`, kind, ts: 1, payload };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function openFactory(socket: FakeSocket): (url: string) => WebSocket {
  return () => {
    queueMicrotask(() => {
      socket.readyState = WebSocket.OPEN;
      socket.emit('open');
    });
    return socket as unknown as WebSocket;
  };
}

async function connectUntilReady(connector: WireConnector, socket: FakeSocket): Promise<void> {
  const pending = connector.connect();
  await delay(10);
  socket.emit('message', Buffer.from(JSON.stringify(envelope('challenge', {
    type: 'challenge',
    nonce: Buffer.from('fixed nonce').toString('base64url'),
  }))), false);
  await delay(10);
  socket.emit('message', Buffer.from(JSON.stringify(envelope('ready', {
    type: 'ready',
    version: { major: 1, minor: 0 },
    capabilities: ['fs.v1'],
  }))), false);
  await pending;
}

function sendFrame(socket: FakeSocket, kind: string, payload: unknown): void {
  socket.emit('message', Buffer.from(JSON.stringify(envelope(kind, payload))), false);
}

function sentEnvelopes(socket: FakeSocket): Array<{ kind?: string; payload?: unknown }> {
  return socket.sent.map((raw) => JSON.parse(raw) as { kind?: string; payload?: unknown });
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const NODE = realpathSync(process.execPath);
const NODE_BASENAME = basename(NODE);

function allowNodeDashE(): CommandPolicy {
  return { rules: [{ executable: NODE, basename: NODE_BASENAME, argv: (argv) => argv[0] === '-e' }] };
}

function makeConnector(
  socket: FakeSocket,
  rest: Partial<Parameters<typeof createRpcEnabledWireConnector>[0]>,
): ReturnType<typeof createRpcEnabledWireConnector> {
  const pair = generateKeyPairSync('ed25519');
  return createRpcEnabledWireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
    rpc: { filesystem: new SafeFilesystem({ roots: [mkdtempSync(join(tmpdir(), 'wire-rpc-runtime-'))] }) },
    ...rest,
  });
}

test('factory preserves observer and dispatches rpc.req through a real RpcDispatcher, including binary round-trip', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-rpc-runtime-test-')));
  try {
    const filesystem = new SafeFilesystem({ roots: [root] });
    const observed: ParsedEnvelope[] = [];
    const socket = new FakeSocket();
    const { connector } = makeConnector(socket, {
      rpc: { filesystem },
      onFrame: (frame) => observed.push(frame),
    });

    await connectUntilReady(connector, socket);
    assert.equal(connector.isReady, true);
    const baseline = socket.sent.length;

    const data = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x10]);
    const filePath = join(root, 'binary.dat');

    sendFrame(socket, 'rpc.req', {
      type: 'rpc.req',
      requestId: 'write-1',
      method: 'fs.write',
      params: { path: filePath, content: encodeWireBytes(data) },
    });
    await delay(20);

    assert.equal(observed.length, 1);
    assert.equal(observed[0]?.status, 'known');
    assert.equal((observed[0] as { kind?: string }).kind, 'rpc.req');

    const sentAfterWrite = sentEnvelopes(socket).slice(baseline);
    assert.equal(sentAfterWrite.length, 1);
    assert.equal(sentAfterWrite[0]?.kind, 'rpc.res');
    assert.deepEqual(sentAfterWrite[0]?.payload, {
      type: 'rpc.res',
      requestId: 'write-1',
      result: { operation: 'write', path: filePath, planned: false },
    });

    sendFrame(socket, 'rpc.req', {
      type: 'rpc.req',
      requestId: 'read-1',
      method: 'fs.read',
      params: { path: filePath },
    });
    await delay(20);

    assert.equal(observed.length, 2);
    const sentAfterRead = sentEnvelopes(socket).slice(baseline);
    assert.equal(sentAfterRead.length, 2);
    assert.equal(sentAfterRead[1]?.kind, 'rpc.res');
    const readPayload = sentAfterRead[1]?.payload as { requestId: string; result: { content: unknown } };
    assert.equal(readPayload.requestId, 'read-1');
    assert.deepEqual(decodeWireBytes(readPayload.result.content), data);

    connector.close();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('observer throw is contained and reported without blocking dispatch or closing the connector', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-rpc-runtime-test-')));
  try {
    const filesystem = new SafeFilesystem({ roots: [root] });
    const transportErrors: unknown[] = [];
    const socket = new FakeSocket();
    const { connector } = makeConnector(socket, {
      rpc: { filesystem },
      onFrame: () => {
        throw new Error('observer boom');
      },
      onRpcTransportError: (error) => transportErrors.push(error),
    });

    await connectUntilReady(connector, socket);
    assert.equal(connector.isReady, true);
    const baseline = socket.sent.length;

    sendFrame(socket, 'rpc.req', {
      type: 'rpc.req',
      requestId: 'stat-1',
      method: 'fs.stat',
      params: { path: root },
    });
    await delay(20);

    assert.equal(transportErrors.length, 1);
    assert.equal((transportErrors[0] as Error).message, 'observer boom');

    const sent = sentEnvelopes(socket).slice(baseline);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.kind, 'rpc.res');
    assert.equal((sent[0]?.payload as { requestId: string }).requestId, 'stat-1');

    assert.equal(connector.isReady, true);
    connector.close();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('non-RPC frame reaches observer only, with no dispatcher side effect or outbound frame', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-rpc-runtime-test-')));
  try {
    const filesystem = new SafeFilesystem({ roots: [root] });
    const observed: ParsedEnvelope[] = [];
    const socket = new FakeSocket();
    const { connector } = makeConnector(socket, {
      rpc: { filesystem },
      onFrame: (frame) => observed.push(frame),
    });

    await connectUntilReady(connector, socket);
    const baseline = socket.sent.length;

    sendFrame(socket, 'ping', { type: 'ping' });
    await delay(20);

    assert.equal(observed.length, 1);
    assert.equal((observed[0] as { kind?: string }).kind, 'ping');
    assert.equal(socket.sent.length, baseline);
    assert.equal(connector.isReady, true);

    connector.close();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('response send failure closes connector, reports transport error exactly once, no unhandledRejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : reason);
  };
  process.on('unhandledRejection', onUnhandled);

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-rpc-runtime-test-')));
  try {
    const filesystem = new SafeFilesystem({ roots: [root] });
    const transportErrors: unknown[] = [];
    const socket = new FakeSocket();
    const { connector } = makeConnector(socket, {
      rpc: { filesystem },
      onRpcTransportError: (error) => transportErrors.push(error),
    });

    await connectUntilReady(connector, socket);
    assert.equal(connector.isReady, true);

    socket.bufferedAmount = 1_048_577;

    sendFrame(socket, 'rpc.req', {
      type: 'rpc.req',
      requestId: 'stat-1',
      method: 'fs.stat',
      params: { path: '.' },
    });
    await delay(20);

    assert.equal(transportErrors.length, 1);
    assert.equal(connector.isReady, false);
    assert.equal(socket.closeCode, 1013);
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('cancel frame is passed raw to dispatcher: cancelled request never gets a response, no connector-side cancel state', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wire-rpc-runtime-test-')));
  try {
    const filesystem = new SafeFilesystem({ roots: [root] });
    const processManager = new ProcessManager({
      roots: [root],
      policy: allowNodeDashE(),
      limits: { maxCommandConcurrency: 1 },
    });
    const socket = new FakeSocket();
    const { connector } = makeConnector(socket, {
      rpc: { filesystem, processManager, maxInFlight: 1 },
    });

    await connectUntilReady(connector, socket);
    const baseline = socket.sent.length;

    const holder = await processManager.start({
      executable: NODE,
      argv: ['-e', 'setInterval(() => {}, 1000);'],
    });
    const idsBeforeRelease = new Set(processManager.list().map((p) => p.id));

    sendFrame(socket, 'rpc.req', {
      type: 'rpc.req',
      requestId: 'pending-1',
      method: 'proc.start',
      params: { executable: NODE, argv: ['-e', 'process.exit(0)'] },
    });
    await delay(20);
    assert.equal(sentEnvelopes(socket).slice(baseline).length, 0);

    sendFrame(socket, 'cancel', { type: 'cancel', requestId: 'pending-1' });
    await delay(20);

    assert.ok(processManager.kill(holder.id, true));
    await waitFor(
      () => processManager.list().find((p) => p.id === holder.id)?.status === 'exited',
      'holder did not exit',
    );

    await delay(30);
    assert.deepEqual(
      processManager.list().filter((p) => !idsBeforeRelease.has(p.id)),
      [],
      'cancelled queued request must not spawn a child',
    );

    const sent = sentEnvelopes(socket).slice(baseline);
    assert.equal(sent.length, 0, 'cancelled request must never receive a response frame');
    assert.equal(
      sent.some((e) => (e.payload as { requestId?: string } | undefined)?.requestId === 'pending-1'),
      false,
    );

    processManager.killAll(true);
    await waitFor(
      () => processManager.list().every((item) => item.status === 'exited'),
      'cleanup did not finish',
    );
    connector.close();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
