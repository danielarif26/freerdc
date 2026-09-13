import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import test from 'node:test';

import { buildAgentAuthTranscript, WIRE_ID } from '@freerdc/protocol';

import { DeviceRegistry } from '../src/device-registry.js';
import { WireHub, WireTransport } from '../src/wire-hub.js';

class FakeTransport extends WireTransport {
  readonly sent: unknown[] = [];
  readonly closeCodes: (number | undefined)[] = [];
  send(frame: unknown): void { this.sent.push(frame); }
  close(code?: number): void { this.closeCodes.push(code); }
}

const envelope = (kind: string, payload: unknown) => ({ v: 'freerdc-wire/1', id: 'frame-1', kind, ts: 1, payload });
const hello = (deviceId = 'device-1', version = { major: 1, minor: 0 }, capabilities = ['fs.v1']) =>
  envelope('hello', { type: 'hello', wireId: WIRE_ID, deviceId, version, capabilities });

function fixture(options: Pick<ConstructorParameters<typeof WireHub>[0], 'sessionSupersedeCooldownMs' | 'onSessionSuperseded'> = {}) {
  const pair = generateKeyPairSync('ed25519');
  let now = new Date('2026-09-10T00:00:00.000Z');
  const registry = new DeviceRegistry(() => now);
  const hub = new WireHub({
    registry, authorizedKeys: new Map([['device-1', pair.publicKey]]),
    nonceSource: () => Buffer.from('fixed nonce'), clock: () => now, sessionIdSource: () => crypto.randomUUID(),
    ...options,
  });
  return { pair, registry, hub, setNow: (value: Date) => { now = value; } };
}

function authenticate(hub: WireHub, transport: FakeTransport, privateKey: KeyObject): string {
  const session = hub.attach(transport);
  hub.receive(session, hello());
  const challenge = (transport.sent[0] as { payload: { nonce: string } }).payload.nonce;
  const signature = sign(null, buildAgentAuthTranscript('device-1', challenge), privateKey).toString('base64url');
  hub.receive(session, envelope('auth', { type: 'auth', wireId: WIRE_ID, signature }));
  return session;
}

test('valid hello/auth sends challenge then ready and registers the device online', () => {
  const { hub, pair, registry } = fixture();
  const transport = new FakeTransport();
  authenticate(hub, transport, pair.privateKey);
  assert.equal((transport.sent[0] as { kind: string }).kind, 'challenge');
  assert.equal((transport.sent[1] as { kind: string }).kind, 'ready');
  assert.deepEqual(registry.get('device-1')?.capabilities, ['fs.v1']);
  assert.equal(registry.get('device-1')?.status, 'online');
});

test('wrong signature and unknown device never register', () => {
  const { hub, pair, registry } = fixture();
  const bad = new FakeTransport();
  const session = hub.attach(bad);
  hub.receive(session, hello());
  hub.receive(session, envelope('auth', { type: 'auth', wireId: WIRE_ID, signature: sign(null, Buffer.from('wrong'), pair.privateKey).toString('base64url') }));
  assert.deepEqual(bad.closeCodes, [1008]);
  assert.equal(registry.get('device-1'), undefined);
  const unknown = new FakeTransport();
  hub.receive(hub.attach(unknown), hello('unknown'));
  assert.deepEqual(unknown.closeCodes, [1008]);
  assert.equal(registry.get('unknown'), undefined);
});

test('version mismatch closes and capability negotiation is reflected in ready', () => {
  const { hub, pair } = fixture();
  const mismatch = new FakeTransport();
  hub.receive(hub.attach(mismatch), hello('device-1', { major: 2, minor: 0 }));
  assert.deepEqual(mismatch.closeCodes, [1008]);
  const transport = new FakeTransport();
  const session = hub.attach(transport);
  hub.receive(session, hello('device-1', { major: 1, minor: 7 }, ['proc.v1', 'fs.v1', 'other']));
  const nonce = (transport.sent[0] as { payload: { nonce: string } }).payload.nonce;
  hub.receive(session, envelope('auth', { type: 'auth', wireId: WIRE_ID, signature: sign(null, buildAgentAuthTranscript('device-1', nonce), pair.privateKey).toString('base64url') }));
  assert.deepEqual((transport.sent[1] as { payload: { version: unknown; capabilities: unknown } }).payload, { type: 'ready', version: { major: 1, minor: 0 }, capabilities: ['fs.v1', 'proc.v1'] });
});

test('authenticated stale takeovers use a reconnect close code and are cooldown-limited', () => {
  const superseded: string[] = [];
  const { hub, pair, registry, setNow } = fixture({
    sessionSupersedeCooldownMs: 1_000,
    onSessionSuperseded: (deviceId) => {
      superseded.push(deviceId);
      throw new Error('observer failure must be contained');
    },
  });
  const first = new FakeTransport();
  const firstSession = authenticate(hub, first, pair.privateKey);
  const second = new FakeTransport();
  const secondSession = authenticate(hub, second, pair.privateKey);

  assert.deepEqual(first.closeCodes, [1012]);
  assert.deepEqual(second.closeCodes, []);
  assert.equal((second.sent[1] as { kind: string }).kind, 'ready');
  assert.deepEqual(superseded, ['device-1']);
  assert.equal(registry.get('device-1')?.status, 'online');

  // Detaching the already superseded session must not offline the new owner.
  hub.detach(firstSession);
  assert.equal(registry.get('device-1')?.status, 'online');

  // A rapid third connection is rejected without evicting the current owner.
  const rejected = new FakeTransport();
  authenticate(hub, rejected, pair.privateKey);
  assert.deepEqual(rejected.closeCodes, [1008]);
  assert.deepEqual(second.closeCodes, []);
  assert.equal(registry.get('device-1')?.status, 'online');

  // Once the cooldown expires, a new authenticated recovery is permitted.
  setNow(new Date('2026-09-10T00:00:01.000Z'));
  const third = new FakeTransport();
  const thirdSession = authenticate(hub, third, pair.privateKey);
  assert.deepEqual(second.closeCodes, [1012]);
  assert.equal((third.sent[1] as { kind: string }).kind, 'ready');
  assert.deepEqual(superseded, ['device-1', 'device-1']);

  hub.detach(secondSession);
  assert.equal(registry.get('device-1')?.status, 'online');
  hub.detach(thirdSession);
  assert.equal(registry.get('device-1')?.status, 'offline');
  assert.deepEqual(third.closeCodes, [undefined]);
});

test('ping responds with matching pong and heartbeats; future frames after ready are ignored', () => {
  const { hub, pair, registry, setNow } = fixture();
  const transport = new FakeTransport();
  const session = authenticate(hub, transport, pair.privateKey);
  setNow(new Date('2026-09-10T00:01:00.000Z'));
  hub.receive(session, envelope('ping', { type: 'ping', nonce: 'keepalive' }));
  assert.deepEqual((transport.sent[2] as { payload: unknown }).payload, { type: 'pong', nonce: 'keepalive' });
  assert.equal(registry.get('device-1')?.lastSeenAt, '2026-09-10T00:01:00.000Z');
  hub.receive(session, envelope('future.v2', { secret: 'do-not-echo' }));
  assert.deepEqual(transport.closeCodes, []);
});

test('malformed input and auth before hello close without sending secret-bearing errors', () => {
  const { hub } = fixture();
  for (const input of [null, envelope('auth', { type: 'auth', wireId: WIRE_ID, signature: 'private-value' })]) {
    const transport = new FakeTransport();
    hub.receive(hub.attach(transport), input);
    assert.deepEqual(transport.closeCodes, [1008]);
    assert.deepEqual(transport.sent, []);
  }
});
