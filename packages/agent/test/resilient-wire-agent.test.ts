import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  createEd25519Signer,
  ProcessManager,
  ResilientRpcWireAgent,
  SafeFilesystem,
  type CommandPolicy,
  type ResilientWireTimer,
} from '../src/index.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, Buffer.alloc(0));
  }
  terminate(): void { this.close(); }
}

class FakeTimers {
  readonly scheduled: Array<{ delayMs: number; callback: () => void; timer: ResilientWireTimer & { cancelled: boolean } }> = [];

  factory = (callback: () => void, delayMs: number): ResilientWireTimer => {
    const timer = {
      cancelled: false,
      cancel(): void { timer.cancelled = true; },
    };
    this.scheduled.push({ delayMs, callback, timer });
    return timer;
  };

  runNext(delayMs?: number): void {
    const item = this.scheduled.find((entry) => !entry.timer.cancelled && (delayMs === undefined || entry.delayMs === delayMs));
    assert.ok(item, `no active timer${delayMs === undefined ? '' : ` at ${delayMs}ms`}`);
    item.timer.cancelled = true;
    item.callback();
  }

  activeDelays(): number[] {
    return this.scheduled.filter((entry) => !entry.timer.cancelled).map((entry) => entry.delayMs);
  }
}

function envelope(kind: string, payload: unknown): Buffer {
  return Buffer.from(JSON.stringify({ v: 'freerdc-wire/1', id: `frame-${kind}`, kind, ts: 1, payload }));
}

function sequentialFactory(sockets: FakeSocket[]): () => WebSocket {
  let index = 0;
  return () => {
    const socket = sockets[index++];
    assert.ok(socket, 'unexpected connector attempt');
    queueMicrotask(() => {
      socket.readyState = WebSocket.OPEN;
      socket.emit('open');
    });
    return socket as unknown as WebSocket;
  };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function ready(socket: FakeSocket): Promise<void> {
  await tick();
  socket.emit('message', envelope('challenge', { type: 'challenge', nonce: Buffer.from('fixed nonce').toString('base64url') }), false);
  await tick();
  socket.emit('message', envelope('ready', { type: 'ready', version: { major: 1, minor: 0 }, capabilities: ['fs.v1'] }), false);
  await tick();
}

function sent(socket: FakeSocket): Array<{ kind?: string; payload?: { requestId?: string; nonce?: string } }> {
  return socket.sent.map((raw) => JSON.parse(raw) as { kind?: string; payload?: { requestId?: string; nonce?: string } });
}

const NODE = realpathSync(process.execPath);
const NODE_BASENAME = basename(NODE);
function allowNodeDashE(): CommandPolicy {
  return { rules: [{ executable: NODE, basename: NODE_BASENAME, argv: (argv) => argv[0] === '-e' }] };
}

function createAgent(root: string, sockets: FakeSocket[], timers: FakeTimers, extra: Partial<ConstructorParameters<typeof ResilientRpcWireAgent>[0]> = {}): ResilientRpcWireAgent {
  const pair = generateKeyPairSync('ed25519');
  return new ResilientRpcWireAgent({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: sequentialFactory(sockets),
    rpc: { filesystem: new SafeFilesystem({ roots: [root] }) },
    timerFactory: timers.factory,
    initialReconnectDelayMs: 100,
    maxReconnectDelayMs: 800,
    reconnectMultiplier: 2,
    reconnectJitterRatio: 0,
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 20,
    heartbeatNonceSource: () => 'heartbeat-fixed',
    ...extra,
  });
}

test('pre-ready failures back off exponentially and a ready connection resets backoff', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resilient-wire-')));
  try {
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    const timers = new FakeTimers();
    const agent = createAgent(root, sockets, timers);
    agent.start();
    await tick();

    sockets[0]!.emit('error', new Error('first failure'));
    await tick();
    assert.deepEqual(timers.activeDelays(), [100]);
    timers.runNext(100);
    await tick();

    sockets[1]!.emit('error', new Error('second failure'));
    await tick();
    assert.deepEqual(timers.activeDelays(), [200]);
    timers.runNext(200);
    await ready(sockets[2]!);
    assert.equal(agent.isReady, true);

    sockets[2]!.emit('error', new Error('post-ready failure'));
    await tick();
    assert.deepEqual(timers.activeDelays(), [100]);
    agent.stop();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('matching pong keeps connection alive and heartbeat timeout reconnects with a fresh connector', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resilient-wire-')));
  try {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const timers = new FakeTimers();
    const agent = createAgent(root, sockets, timers);
    agent.start();
    await ready(sockets[0]!);

    assert.deepEqual(timers.activeDelays(), [50]);
    timers.runNext(50);
    const ping = sent(sockets[0]!).at(-1);
    assert.equal(ping?.kind, 'ping');
    assert.equal(ping?.payload?.nonce, 'heartbeat-fixed');
    assert.deepEqual(timers.activeDelays(), [20]);

    sockets[0]!.emit('message', envelope('pong', { type: 'pong', nonce: 'heartbeat-fixed' }), false);
    await tick();
    assert.equal(agent.isReady, true);
    assert.deepEqual(timers.activeDelays(), [50]);

    timers.runNext(50);
    assert.deepEqual(timers.activeDelays(), [20]);
    timers.runNext(20);
    await tick();
    assert.equal(agent.isReady, false);
    assert.deepEqual(timers.activeDelays(), [100]);

    timers.runNext(100);
    await ready(sockets[1]!);
    assert.equal(agent.isReady, true);
    agent.stop();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('wrong pong nonce does not satisfy liveness deadline', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resilient-wire-')));
  try {
    const socket = new FakeSocket();
    const timers = new FakeTimers();
    const agent = createAgent(root, [socket], timers);
    agent.start();
    await ready(socket);
    timers.runNext(50);
    socket.emit('message', envelope('pong', { type: 'pong', nonce: 'wrong' }), false);
    await tick();
    assert.deepEqual(timers.activeDelays(), [20]);
    agent.stop();
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('stop cancels recovery and heartbeat timers', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resilient-wire-')));
  try {
    const socket = new FakeSocket();
    const timers = new FakeTimers();
    const agent = createAgent(root, [socket], timers);
    agent.start();
    await ready(socket);
    assert.deepEqual(timers.activeDelays(), [50]);
    agent.stop();
    assert.equal(agent.isRunning, false);
    assert.equal(agent.isReady, false);
    assert.deepEqual(timers.activeDelays(), []);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('an interrupted mutating RPC stays bound to the old connector and is never replayed after reconnect', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'resilient-wire-')));
  const processManager = new ProcessManager({
    roots: [root],
    policy: allowNodeDashE(),
    limits: { maxCommandConcurrency: 1 },
  });
  try {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const timers = new FakeTimers();
    const pair = generateKeyPairSync('ed25519');
    const agent = new ResilientRpcWireAgent({
      endpoint: 'ws://127.0.0.1:8787/agent',
      deviceId: 'device-1',
      signer: createEd25519Signer(pair.privateKey),
      webSocketFactory: sequentialFactory(sockets),
      rpc: { filesystem: new SafeFilesystem({ roots: [root] }), processManager, maxInFlight: 1 },
      timerFactory: timers.factory,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 100,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 10_000,
    });

    const holder = await processManager.start({ executable: NODE, argv: ['-e', 'setInterval(() => {}, 1000);'] });
    agent.start();
    await ready(sockets[0]!);
    const firstBaseline = sockets[0]!.sent.length;

    sockets[0]!.emit('message', envelope('rpc.req', {
      type: 'rpc.req', requestId: 'mutating-old', method: 'proc.start',
      params: { executable: NODE, argv: ['-e', 'process.exit(0)'] },
    }), false);
    await tick();
    assert.equal(sent(sockets[0]!).slice(firstBaseline).some((frame) => frame.payload?.requestId === 'mutating-old'), false);

    sockets[0]!.emit('error', new Error('link lost'));
    await tick();
    timers.runNext(100);
    await ready(sockets[1]!);
    const secondBaseline = sockets[1]!.sent.length;

    assert.ok(processManager.kill(holder.id, true));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (processManager.list().some((item) => item.id !== holder.id)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const replacementFrames = sent(sockets[1]!).slice(secondBaseline);
    assert.equal(replacementFrames.some((frame) => frame.payload?.requestId === 'mutating-old'), false);
    agent.stop();
  } finally {
    processManager.killAll(true);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
