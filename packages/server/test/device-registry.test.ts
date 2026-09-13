import assert from 'node:assert/strict';
import test from 'node:test';

import { DeviceRegistry } from '../src/device-registry.js';

test('register creates an online device with deterministic ISO timestamps and normalized capabilities', () => {
  const now = new Date('2026-09-10T12:34:56.789Z');
  const registry = new DeviceRegistry(() => now);
  const record = registry.register({
    id: 'device-1',
    displayName: '  Living Room TV  ',
    capabilities: ['video', 'audio', 'video'],
  });

  assert.deepEqual(record, {
    id: 'device-1',
    displayName: '  Living Room TV  ',
    capabilities: ['audio', 'video'],
    status: 'online',
    registeredAt: '2026-09-10T12:34:56.789Z',
    lastSeenAt: '2026-09-10T12:34:56.789Z',
  });
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.capabilities));
});

test('register rejects duplicate ids and invalid device input', () => {
  const registry = new DeviceRegistry(() => new Date('2026-09-10T00:00:00.000Z'));
  registry.register({ id: 'device-1', displayName: 'TV', capabilities: ['video'] });

  assert.throws(() => registry.register({ id: 'device-1', displayName: 'Other', capabilities: [] }));
  for (const id of ['', ' ', 'bad id', '../device', 'a'.repeat(129)]) {
    assert.throws(() => registry.register({ id, displayName: 'TV', capabilities: [] }));
  }
  for (const capabilities of [
    [''],
    [' '],
    ['bad capability'],
    ['a'.repeat(129)],
    Array.from({ length: 65 }, (_, index) => `cap-${index}`),
  ]) {
    assert.throws(() => registry.register({ id: `device-${Math.random()}`, displayName: 'TV', capabilities }));
  }
  for (const displayName of ['', 'TV\nRoom', 'a'.repeat(129)]) {
    assert.throws(() => registry.register({ id: `name-${Math.random()}`, displayName, capabilities: [] }));
  }
});

test('register rejects unknown runtime keys', () => {
  const registry = new DeviceRegistry();
  for (const key of ['token', 'publicKey', 'filesystem', 'processManager', 'path', 'argv']) {
    assert.throws(() => registry.register({
      id: `device-${key}`,
      displayName: 'TV',
      capabilities: [],
      [key]: 'untrusted',
    } as never));
  }
});

test('heartbeat and markOffline update device state predictably', () => {
  let now = new Date('2026-09-10T00:00:00.000Z');
  const registry = new DeviceRegistry(() => now);
  registry.register({ id: 'device-1', displayName: 'TV', capabilities: [] });
  now = new Date('2026-09-10T00:01:00.000Z');

  const heartbeated = registry.heartbeat('device-1');
  assert.equal(heartbeated?.status, 'online');
  assert.equal(heartbeated?.lastSeenAt, '2026-09-10T00:01:00.000Z');

  now = new Date('2026-09-10T00:02:00.000Z');
  const offline = registry.markOffline('device-1');
  assert.equal(offline?.status, 'offline');
  assert.equal(offline?.lastSeenAt, heartbeated?.lastSeenAt);
  assert.equal(registry.heartbeat('missing'), undefined);
  assert.equal(registry.markOffline('missing'), undefined);
});

test('unregister reports whether a device existed and list is sorted', () => {
  const registry = new DeviceRegistry();
  registry.register({ id: 'z-device', displayName: 'Z', capabilities: [] });
  registry.register({ id: 'a-device', displayName: 'A', capabilities: [] });

  assert.deepEqual(registry.list().map((record) => record.id), ['a-device', 'z-device']);
  assert.equal(registry.unregister('a-device'), true);
  assert.equal(registry.unregister('a-device'), false);
});

test('registry returns frozen defensive copies', () => {
  const registry = new DeviceRegistry();
  const registered = registry.register({ id: 'device-1', displayName: 'TV', capabilities: ['audio'] });
  const fetched = registry.get('device-1');
  const listed = registry.list()[0];

  for (const record of [registered, fetched, listed]) {
    assert.ok(record);
    assert.ok(Object.isFrozen(record));
    assert.ok(Object.isFrozen(record.capabilities));
    assert.throws(() => { (record as { displayName: string }).displayName = 'Changed'; });
    assert.throws(() => { (record as unknown as { capabilities: string[] }).capabilities.push('video'); });
  }

  const actual = registry.get('device-1');
  assert.equal(actual?.displayName, 'TV');
  assert.deepEqual(actual?.capabilities, ['audio']);
});
