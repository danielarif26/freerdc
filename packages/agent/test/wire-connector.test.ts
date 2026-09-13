import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WIRE_ID } from '@freerdc/protocol';
import { WebSocket } from 'ws';

import {
  createEd25519Signer,
  validateAgentEndpoint,
  WireConnector,
} from '../src/index.js';

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
  return { v: 'freerdc-wire/1', id: 'frame-1', kind, ts: 1, payload };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function openFactory(socket: FakeSocket, afterOpen?: () => void): (url: string) => WebSocket {
  return () => {
    queueMicrotask(() => {
      socket.readyState = WebSocket.OPEN;
      socket.emit('open');
      afterOpen?.();
    });
    return socket as unknown as WebSocket;
  };
}

test('validateAgentEndpoint accepts loopback ws /agent forms including IPv6 and explicit ports', () => {
  const accepted = [
    'ws://[::1]:8787/agent',
    'ws://[::1]:1/agent',
    'ws://[::1]:65535/agent',
    'ws://[::1]/agent',
    'ws://localhost/agent',
    'ws://localhost:80/agent',
    'ws://localhost:8787/agent',
    'ws://127.0.0.1/agent',
    'ws://127.0.0.1:80/agent',
    'ws://127.0.0.1:8787/agent',
    'ws://127.0.0.1:54321/agent',
  ];
  for (const endpoint of accepted) {
    const url = validateAgentEndpoint(endpoint);
    assert.equal(url.pathname, '/agent');
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), endpoint);
  }
});

test('validateAgentEndpoint rejects non-loopback, other schemes, suffix, credentials, query, fragment, and bad ports', () => {
  const rejected = [
    'ws://192.168.1.1:8787/agent',
    'ws://0.0.0.0:8787/agent',
    'ws://[2001:db8::1]:8787/agent',
    'wss://127.0.0.1:8787/agent',
    'http://127.0.0.1:8787/agent',
    'https://127.0.0.1:8787/agent',
    'ws://127.0.0.1:8787/agent/',
    'ws://user:pass@127.0.0.1:8787/agent',
    'ws://127.0.0.1:8787/agent?x=1',
    'ws://127.0.0.1:8787/agent#frag',
    'ws://127.0.0.1:0/agent',
    'ws://127.0.0.1:99999/agent',
    'ws://127.0.0.1:abc/agent',
    'not-a-url',
  ];
  for (const endpoint of rejected) {
    assert.throws(() => validateAgentEndpoint(endpoint), TypeError, endpoint);
  }
});

test('constructor validates endpoint without connecting, including IPv6', () => {
  const pair = generateKeyPairSync('ed25519');
  const connector = new WireConnector({
    endpoint: 'ws://[::1]:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
  });
  assert.equal(connector.isReady, false);
  assert.equal(connector.endpoint, 'ws://[::1]:8787/agent');
});

test('handshake timeout is deterministic and never reports ready', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    handshakeTimeoutMs: 30,
    webSocketFactory: openFactory(socket),
  });
  await assert.rejects(connector.connect(), /timed out/);
  assert.equal(connector.isReady, false);
});

test('ready after close is ignored', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    handshakeTimeoutMs: 200,
    webSocketFactory: openFactory(socket),
  });
  const pending = connector.connect();
  await delay(10);
  connector.close();
  await assert.rejects(pending);
  socket.emit('message', Buffer.from(JSON.stringify(envelope('ready', {
    type: 'ready',
    version: { major: 1, minor: 0 },
    capabilities: ['fs.v1'],
  }))), false);
  await delay(10);
  assert.equal(connector.isReady, false);
});

test('wrong handshake ordering fails closed', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    handshakeTimeoutMs: 200,
    webSocketFactory: openFactory(socket, () => {
      socket.emit('message', Buffer.from(JSON.stringify(envelope('ready', {
        type: 'ready',
        version: { major: 1, minor: 0 },
        capabilities: ['fs.v1'],
      }))), false);
    }),
  });
  await assert.rejects(connector.connect());
  assert.equal(connector.isReady, false);
});

test('bufferedAmount ceiling fails closed with 1013 and does not send', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  socket.bufferedAmount = 1_048_577;
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await assert.rejects(connector.connect());
  assert.equal(connector.isReady, false);
  assert.equal(socket.closeCode, 1013);
  assert.deepEqual(socket.sent, []);
});

test('rpc.req after ready is exposed on onFrame and is not executed', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const frames: string[] = [];
  let rpcExecuted = false;
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    capabilities: ['fs.v1'],
    signer: createEd25519Signer(pair.privateKey),
    onFrame: (parsed) => {
      frames.push(parsed.kind);
      if (parsed.status === 'known' && parsed.kind === 'rpc.req') {
        rpcExecuted = false;
      }
    },
    webSocketFactory: openFactory(socket),
  });

  const pending = connector.connect();
  await delay(10);
  const hello = JSON.parse(socket.sent[0] ?? '{}') as { kind?: string; payload?: { wireId?: string } };
  assert.equal(hello.kind, 'hello');
  assert.equal(hello.payload?.wireId, WIRE_ID);

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
  assert.equal(connector.isReady, true);

  socket.emit('message', Buffer.from(JSON.stringify(envelope('rpc.req', {
    type: 'rpc.req',
    requestId: 'request-1',
    method: 'fs.read',
    params: { path: '/etc/passwd' },
  }))), false);
  await delay(10);

  assert.deepEqual(frames, ['rpc.req']);
  assert.equal(rpcExecuted, false);
  assert.equal('dispatch' in connector, false);
  assert.equal('execute' in connector, false);
  assert.equal('request' in connector, false);
  assert.equal(connector.isReady, true);
  connector.close();
});

test('onFrame throw after ready fails closed with no unhandledRejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason instanceof Error ? reason.message : reason);
  };
  process.on('unhandledRejection', onUnhandled);

  try {
    const pair = generateKeyPairSync('ed25519');
    const socket = new FakeSocket();
    const connector = new WireConnector({
      endpoint: 'ws://127.0.0.1:8787/agent',
      deviceId: 'device-1',
      signer: createEd25519Signer(pair.privateKey),
      onFrame: () => {
        throw new Error('boom');
      },
      webSocketFactory: openFactory(socket),
    });

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
    assert.equal(connector.isReady, true);
    assert.equal(socket.readyState, WebSocket.OPEN);

    socket.emit('message', Buffer.from(JSON.stringify(envelope('rpc.req', {
      type: 'rpc.req',
      requestId: 'request-1',
      method: 'fs.read',
      params: { path: '/tmp/x' },
    }))), false);
    await delay(20);

    assert.deepEqual(unhandled, []);
    assert.equal(connector.isReady, false);
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

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

test('sendRpcResult after ready sends exact rpc.res frame with matching requestId', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);
  assert.equal(connector.isReady, true);

  const before = socket.sent.length;
  connector.sendRpcResult('request-1', { ok: true });
  assert.equal(socket.sent.length, before + 1);
  const sent = JSON.parse(socket.sent[before] ?? '{}') as {
    kind?: string;
    payload?: unknown;
  };
  assert.equal(sent.kind, 'rpc.res');
  assert.deepEqual(sent.payload, {
    type: 'rpc.res',
    requestId: 'request-1',
    result: { ok: true },
  });
  connector.close();
});

test('sendRpcError after ready sends exact rpc.err frame with matching requestId and code only', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);
  assert.equal(connector.isReady, true);

  const before = socket.sent.length;
  connector.sendRpcError('request-2', { code: 'E_INTERNAL' });
  assert.equal(socket.sent.length, before + 1);
  const sent = JSON.parse(socket.sent[before] ?? '{}') as {
    kind?: string;
    payload?: unknown;
  };
  assert.equal(sent.kind, 'rpc.err');
  assert.deepEqual(sent.payload, {
    type: 'rpc.err',
    requestId: 'request-2',
    error: { code: 'E_INTERNAL' },
  });
  connector.close();
});

test('sendRpcResult and sendRpcError before ready throw and do not send', () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  assert.equal(connector.isReady, false);
  assert.throws(() => connector.sendRpcResult('request-1', { ok: true }));
  assert.throws(() => connector.sendRpcError('request-1', { code: 'E_INTERNAL' }));
  assert.deepEqual(socket.sent, []);
});

test('sendRpcResult and sendRpcError after close throw and do not send', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);
  connector.close();
  assert.equal(connector.isReady, false);

  const before = socket.sent.length;
  assert.throws(() => connector.sendRpcResult('request-1', { ok: true }));
  assert.throws(() => connector.sendRpcError('request-1', { code: 'E_INTERNAL' }));
  assert.equal(socket.sent.length, before);
});


test('sendPing after ready sends exact ping frame', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);

  const before = socket.sent.length;
  connector.sendPing('heartbeat-1');
  assert.equal(socket.sent.length, before + 1);
  const sent = JSON.parse(socket.sent[before] ?? '{}') as {
    kind?: string;
    payload?: unknown;
  };
  assert.equal(sent.kind, 'ping');
  assert.deepEqual(sent.payload, { type: 'ping', nonce: 'heartbeat-1' });
  connector.close();
});

test('sendPing before ready and after close throws without sending', async () => {
  const pair = generateKeyPairSync('ed25519');
  const beforeReadySocket = new FakeSocket();
  const beforeReady = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(beforeReadySocket),
  });
  assert.throws(() => beforeReady.sendPing('heartbeat-1'), /not ready/);
  assert.deepEqual(beforeReadySocket.sent, []);

  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-2',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);
  connector.close();
  const baseline = socket.sent.length;
  assert.throws(() => connector.sendPing('heartbeat-2'), /not ready/);
  assert.equal(socket.sent.length, baseline);
});

test('sendPing rejects invalid nonce without sending', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);
  const baseline = socket.sent.length;

  for (const nonce of ['', 'x'.repeat(129), 'a\n', '\x00', 'a\x7f']) {
    assert.throws(
      () => connector.sendPing(nonce),
      (error: unknown) => error instanceof TypeError && error.message === 'nonce must be 1 to 128 printable characters',
    );
  }
  assert.equal(socket.sent.length, baseline);
  connector.close();
});

test('onDisconnected fires exactly once after an established ready connection settles', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  const disconnected: string[] = [];
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    onDisconnected: (error) => disconnected.push(error.message),
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);

  socket.emit('error', new Error('link lost'));
  await delay(10);
  socket.emit('close', 1006, Buffer.alloc(0));
  connector.close();

  assert.deepEqual(disconnected, ['link lost']);
  assert.equal(connector.isReady, false);
});

test('onDisconnected does not fire for a pre-ready handshake timeout', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  let disconnected = 0;
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    handshakeTimeoutMs: 30,
    onDisconnected: () => { disconnected += 1; },
    webSocketFactory: openFactory(socket),
  });

  await assert.rejects(connector.connect(), /timed out/);
  assert.equal(disconnected, 0);
});

test('throwing onDisconnected callback is contained', async () => {
  const pair = generateKeyPairSync('ed25519');
  const socket = new FakeSocket();
  let calls = 0;
  const connector = new WireConnector({
    endpoint: 'ws://127.0.0.1:8787/agent',
    deviceId: 'device-1',
    signer: createEd25519Signer(pair.privateKey),
    onDisconnected: () => {
      calls += 1;
      throw new Error('observer boom');
    },
    webSocketFactory: openFactory(socket),
  });
  await connectUntilReady(connector, socket);

  assert.doesNotThrow(() => connector.close());
  assert.equal(calls, 1);
  assert.equal(connector.isReady, false);
});
