import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFreeRdcRuntime } from '../src/runtime.js';

async function request(port: number, path = '/mcp'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });
}

test('runtime requires explicit absolute roots and creates private FreeRDC-only state', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'freerdc-runtime-'));
  const root = join(parent, 'root');
  const stateDir = join(parent, 'state');
  mkdirSync(root);
  try {
    assert.throws(() => createFreeRdcRuntime({ roots: [], stateDir }), /roots/);
    assert.throws(() => createFreeRdcRuntime({ roots: ['relative'], stateDir }), /absolute/);
    assert.throws(() => createFreeRdcRuntime({ roots: [root], stateDir: join(homedir(), '.ssh') }), /protected/);

    const runtime = createFreeRdcRuntime({ roots: [root], stateDir, port: 0 });
    const address = await runtime.start();
    try {
      assert.equal(address.host, '127.0.0.1');
      assert.equal(lstatSync(stateDir).isSymbolicLink(), false);
      assert.equal(lstatSync(stateDir).mode & 0o777, 0o700);
      const unknown = await request(address.port, '/not-a-route');
      assert.equal(unknown.status, 404);
    } finally {
      await runtime.close();
    }
    assert.ok(readFileSync(join(stateDir, 'audit.jsonl'), 'utf8').length >= 0);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('STOP sentinel makes health fail closed without changing the loopback boundary', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'freerdc-runtime-stop-'));
  const root = join(parent, 'root');
  const stateDir = join(parent, 'state');
  mkdirSync(root);
  const runtime = createFreeRdcRuntime({ roots: [root], stateDir, port: 0 });
  try {
    const address = await runtime.start();
    writeFileSync(join(stateDir, 'STOP'), 'stop\n', { mode: 0o600 });
    assert.equal(address.host, '127.0.0.1');
  } finally {
    await runtime.close();
    rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});


test('runtime rejects a symlink state directory without chmod-following its target', () => {
  const parent = mkdtempSync(join(tmpdir(), 'freerdc-runtime-symlink-'));
  const root = join(parent, 'root');
  const target = join(parent, 'target');
  const stateDir = join(parent, 'state-link');
  mkdirSync(root);
  mkdirSync(target);
  chmodSync(target, 0o755);
  symlinkSync(target, stateDir, 'dir');
  try {
    assert.throws(() => createFreeRdcRuntime({ roots: [root], stateDir }), /non-symlink/);
    assert.equal(lstatSync(target).mode & 0o777, 0o755);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('runtime rejects custom state directories that overlap configured roots', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'freerdc-runtime-overlap-'));
  const root = join(parent, 'root');
  const rootWithinState = join(parent, 'state-containing-root', 'root');
  const stateWithinRoot = join(root, 'state');
  const stateContainingRoot = join(parent, 'state-containing-root');
  const nonOverlappingState = join(parent, 'non-overlapping-state');
  const symlinkedRoot = join(parent, 'root-link');
  mkdirSync(root);
  mkdirSync(stateContainingRoot);
  mkdirSync(rootWithinState);
  symlinkSync(root, symlinkedRoot, 'dir');
  try {
    assert.throws(
      () => createFreeRdcRuntime({ roots: [`${root}/../root`], stateDir: root }),
      /stateDir must not overlap a filesystem root/,
    );
    assert.throws(
      () => createFreeRdcRuntime({ roots: [root], stateDir: stateWithinRoot }),
      /stateDir must not overlap a filesystem root/,
    );
    assert.throws(
      () => createFreeRdcRuntime({ roots: [rootWithinState], stateDir: stateContainingRoot }),
      /stateDir must not overlap a filesystem root/,
    );
    assert.throws(
      () => createFreeRdcRuntime({ roots: [symlinkedRoot], stateDir: stateWithinRoot }),
      /stateDir must not overlap a filesystem root/,
    );

    const runtime = createFreeRdcRuntime({ roots: [root], stateDir: nonOverlappingState, port: 0 });
    await runtime.close();
    assert.equal(lstatSync(nonOverlappingState).mode & 0o777, 0o700);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('runtime can privately initialize its default state while filesystem policy denies it', () => {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'freerdc-runtime-home-'));
  const permittedRoot = join(temporaryHome, 'workspace');
  mkdirSync(permittedRoot);
  const runtimeModule = new URL('../src/runtime.js', import.meta.url).href;
  const script = `
    import { createFreeRdcRuntime } from ${JSON.stringify(runtimeModule)};
    import { isDenied } from '@freerdc/guard';
    import { homedir } from 'node:os';
    import { join } from 'node:path';
    const stateDir = join(homedir(), '.freerdc');
    if (!isDenied(stateDir) || !isDenied(join(stateDir, 'audit.jsonl'))) process.exit(2);
    const runtime = createFreeRdcRuntime({ roots: [${JSON.stringify(permittedRoot)}], port: 0 });
    if (runtime.stateDir !== stateDir) process.exit(3);
    await runtime.close();
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, HOME: temporaryHome },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(lstatSync(join(temporaryHome, '.freerdc')).mode & 0o777, 0o700);
  } finally {
    rmSync(temporaryHome, { recursive: true, force: true, maxRetries: 3 });
  }
});
