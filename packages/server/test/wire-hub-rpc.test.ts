import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';

import { buildAgentAuthTranscript, E_CONCURRENCY_LIMIT, E_DEVICE_OFFLINE, E_INTERNAL, E_TIMEOUT, E_TOO_LARGE, FreeRdcError, WIRE_ID } from '@freerdc/protocol';

import { DeviceRegistry } from '../src/device-registry.js';
import { WireHub, WireTransport } from '../src/wire-hub.js';

class FakeTransport extends WireTransport {
  readonly sent: unknown[] = [];
  readonly closeCodes: (number | undefined)[] = [];
  throwOnSend = false;
  readonly throwOnKinds = new Set<string>();
  throwOnClose = false;
  send(frame: unknown): void {
    const kind = frame && typeof frame === 'object' && 'kind' in frame ? frame.kind : undefined;
    if (this.throwOnSend || typeof kind === 'string' && this.throwOnKinds.has(kind)) throw new Error('send failed');
    this.sent.push(frame);
  }
  close(code?: number): void {
    this.closeCodes.push(code);
    if (this.throwOnClose) throw new Error('close failed');
  }
}

const envelope = (kind: string, payload: unknown) => ({ v: 'freerdc-wire/1', id: crypto.randomUUID(), kind, ts: 1, payload });

function fixture(overrides: Partial<ConstructorParameters<typeof WireHub>[0]> = {}, pair = generateKeyPairSync('ed25519')) {
  const registry = new DeviceRegistry(() => new Date('2026-09-10T00:00:00.000Z'));
  let requestNumber = 0;
  const hub = new WireHub({
    registry,
    authorizedKeys: new Map([['device-1', pair.publicKey]]),
    nonceSource: () => Buffer.from('fixed nonce'),
    sessionIdSource: () => crypto.randomUUID(),
    requestIdSource: () => `request-${++requestNumber}`,
    ...overrides,
  });
  return { hub, pair, registry };
}

function authenticate(hub: WireHub, transport: FakeTransport, privateKey: KeyObject, deviceId = 'device-1'): string {
  const session = hub.attach(transport);
  hub.receive(session, envelope('hello', { type: 'hello', wireId: WIRE_ID, deviceId, version: { major: 1, minor: 0 }, capabilities: ['fs.v1'] }));
  const nonce = (transport.sent[0] as { payload: { nonce: string } }).payload.nonce;
  hub.receive(session, envelope('auth', { type: 'auth', wireId: WIRE_ID, signature: sign(null, buildAgentAuthTranscript(deviceId, nonce), privateKey).toString('base64url') }));
  return session;
}

function rpcRequest(transport: FakeTransport): { requestId: string; method: string; params?: unknown } {
  return (transport.sent.at(-1) as { payload: { requestId: string; method: string; params?: unknown } }).payload;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FreeRdcError && error.code === code);
}

test('authenticated request sends rpc.req and matching rpc.res resolves once', async () => {
  const { hub, pair } = fixture();
  const transport = new FakeTransport();
  const session = authenticate(hub, transport, pair.privateKey);
  const pending = hub.request('device-1', 'fs.read', { path: '/safe' });
  const request = rpcRequest(transport);
  assert.deepEqual(request, { type: 'rpc.req', requestId: 'request-1', method: 'fs.read', params: { path: '/safe' } });
  hub.receive(session, envelope('rpc.res', { type: 'rpc.res', requestId: request.requestId, result: { value: 1 } }));
  assert.deepEqual(await pending, { value: 1 });
  hub.receive(session, envelope('rpc.res', { type: 'rpc.res', requestId: request.requestId, result: 'ignored' }));
});

test('rpc.err maps canonical codes and sanitizes unknown error codes', async () => {
  const { hub, pair } = fixture();
  const transport = new FakeTransport();
  const session = authenticate(hub, transport, pair.privateKey);
  const known = hub.request('device-1', 'fs.read');
  hub.receive(session, envelope('rpc.err', { type: 'rpc.err', requestId: rpcRequest(transport).requestId, error: { code: E_TOO_LARGE, message: 'ignored' } }));
  await expectCode(known, E_TOO_LARGE);
  const unknown = hub.request('device-1', 'fs.read');
  hub.receive(session, envelope('rpc.err', { type: 'rpc.err', requestId: rpcRequest(transport).requestId, error: { code: 'secret-code', message: 'secret-value' } }));
  await expectCode(unknown, E_INTERNAL);
});

test('timeout cancels the request and rejects with E_TIMEOUT', async () => {
  const { hub, pair } = fixture({ requestTimeoutMs: 5 });
  const transport = new FakeTransport();
  authenticate(hub, transport, pair.privateKey);
  const pending = hub.request('device-1', 'fs.read');
  const requestId = rpcRequest(transport).requestId;
  await expectCode(pending, E_TIMEOUT);
  assert.deepEqual((transport.sent.at(-1) as { payload: unknown }).payload, { type: 'cancel', requestId });
});

test('challenge send failure closes the session without escaping receive', () => {
  const { hub, registry } = fixture();
  const transport = new FakeTransport();
  transport.throwOnKinds.add('challenge');
  const session = hub.attach(transport);
  assert.doesNotThrow(() => hub.receive(session, envelope('hello', {
    type: 'hello', wireId: WIRE_ID, deviceId: 'device-1', version: { major: 1, minor: 0 }, capabilities: ['fs.v1'],
  })));
  assert.deepEqual(transport.closeCodes, [1008]);
  assert.equal(registry.get('device-1'), undefined);
});

test('ready send failure leaves no phantom online or routable device', async () => {
  const { hub, pair, registry } = fixture();
  const transport = new FakeTransport();
  transport.throwOnKinds.add('ready');
  const session = hub.attach(transport);
  hub.receive(session, envelope('hello', {
    type: 'hello', wireId: WIRE_ID, deviceId: 'device-1', version: { major: 1, minor: 0 }, capabilities: ['fs.v1'],
  }));
  const nonce = (transport.sent[0] as { payload: { nonce: string } }).payload.nonce;
  assert.doesNotThrow(() => hub.receive(session, envelope('auth', {
    type: 'auth', wireId: WIRE_ID,
    signature: sign(null, buildAgentAuthTranscript('device-1', nonce), pair.privateKey).toString('base64url'),
  })));
  assert.deepEqual(transport.closeCodes, [1008]);
  assert.equal(registry.get('device-1')?.status, 'offline');
  await expectCode(hub.request('device-1', 'fs.read'), E_DEVICE_OFFLINE);
});

test('pong send failure closes the ready session without escaping receive', async () => {
  const { hub, pair, registry } = fixture();
  const transport = new FakeTransport();
  const session = authenticate(hub, transport, pair.privateKey);
  transport.throwOnKinds.add('pong');
  assert.doesNotThrow(() => hub.receive(session, envelope('ping', { type: 'ping', nonce: 'ping-nonce' })));
  assert.deepEqual(transport.closeCodes, [1008]);
  assert.equal(registry.get('device-1')?.status, 'offline');
  await expectCode(hub.request('device-1', 'fs.read'), E_DEVICE_OFFLINE);
});

test('timeout still rejects E_TIMEOUT when cancel send and close both throw', async () => {
  const { hub, pair } = fixture({ requestTimeoutMs: 5 });
  const transport = new FakeTransport();
  authenticate(hub, transport, pair.privateKey);
  transport.throwOnKinds.add('cancel');
  transport.throwOnClose = true;
  await expectCode(hub.request('device-1', 'fs.read'), E_TIMEOUT);
  assert.deepEqual(transport.closeCodes, [1008]);
});

test('per-device pending cap rejects the second request', async () => {
  const { hub, pair } = fixture({ maxPendingPerDevice: 1 });
  const transport = new FakeTransport();
  const session = authenticate(hub, transport, pair.privateKey);
  const first = hub.request('device-1', 'fs.read');
  await expectCode(hub.request('device-1', 'fs.stat'), E_CONCURRENCY_LIMIT);
  hub.receive(session, envelope('rpc.res', { type: 'rpc.res', requestId: rpcRequest(transport).requestId, result: null }));
  await first;
});

test('detach rejects pending requests and makes the device offline', async () => {
  const { hub, pair, registry } = fixture();
  const transport = new FakeTransport();
  const session = authenticate(hub, transport, pair.privateKey);
  const pending = hub.request('device-1', 'fs.read');
  hub.detach(session);
  await expectCode(pending, E_DEVICE_OFFLINE);
  assert.equal(registry.get('device-1')?.status, 'offline');
  await expectCode(hub.request('device-1', 'fs.read'), E_DEVICE_OFFLINE);
});

test('authenticated sessions keep colliding request IDs isolated for responses and errors', async () => {
  const pair = generateKeyPairSync('ed25519');
  const pair2 = generateKeyPairSync('ed25519');
  const { hub, registry } = fixture({
    authorizedKeys: new Map([['device-1', pair.publicKey], ['device-2', pair2.publicKey]]),
    requestIdSource: () => 'shared-request',
  }, pair);
  const transport1 = new FakeTransport();
  const transport2 = new FakeTransport();
  const session1 = authenticate(hub, transport1, pair.privateKey, 'device-1');
  const session2 = authenticate(hub, transport2, pair2.privateKey, 'device-2');

  const first1 = hub.request('device-1', 'fs.read');
  const first2 = hub.request('device-2', 'fs.read');
  hub.receive(session2, envelope('rpc.err', { type: 'rpc.err', requestId: 'shared-request', error: { code: E_TOO_LARGE } }));
  await expectCode(first2, E_TOO_LARGE);
  let first1Settled = false;
  void first1.then(() => { first1Settled = true; }, () => { first1Settled = true; });
  await Promise.resolve();
  assert.equal(first1Settled, false);
  hub.receive(session1, envelope('rpc.res', { type: 'rpc.res', requestId: 'shared-request', result: 'device-1-result' }));
  assert.equal(await first1, 'device-1-result');

  const second1 = hub.request('device-1', 'fs.read');
  const second2 = hub.request('device-2', 'fs.read');
  hub.receive(session2, envelope('rpc.res', { type: 'rpc.res', requestId: 'shared-request', result: 'wrong-device-2-result' }));
  assert.equal(await second2, 'wrong-device-2-result');
  let second1Settled = false;
  void second1.then(() => { second1Settled = true; }, () => { second1Settled = true; });
  await Promise.resolve();
  assert.equal(second1Settled, false);
  hub.receive(session1, envelope('rpc.err', { type: 'rpc.err', requestId: 'shared-request', error: { code: E_INTERNAL } }));
  await expectCode(second1, E_INTERNAL);
  assert.equal(registry.get('device-1')?.status, 'online');
  assert.equal(registry.get('device-2')?.status, 'online');
});

test('transport send failure closes the session, rejects, and marks the device offline', async () => {
  const { hub, pair, registry } = fixture();
  const transport = new FakeTransport();
  authenticate(hub, transport, pair.privateKey);
  transport.throwOnSend = true;
  await expectCode(hub.request('device-1', 'fs.read'), E_DEVICE_OFFLINE);
  assert.equal(registry.get('device-1')?.status, 'offline');
  assert.deepEqual(transport.closeCodes, [1008]);
});
