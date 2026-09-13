import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FileStateProvider,
  InMemoryStateProvider,
  isKillSwitchActive,
  type StateProvider,
} from '../src/index.js';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'freerdc-kill-switch-'));
}

test('FileStateProvider is inactive when its injected STOP path is missing', () => {
  const directory = temporaryDirectory();
  const provider = new FileStateProvider(join(directory, 'STOP'));

  assert.equal(provider.isActive(), false);
});

test('FileStateProvider is active when its injected STOP file is present', () => {
  const directory = temporaryDirectory();
  const stopPath = join(directory, 'STOP');
  writeFileSync(stopPath, 'stop');

  assert.equal(new FileStateProvider(stopPath).isActive(), true);
});

test('isKillSwitchActive fails closed when a provider throws', () => {
  const provider: StateProvider = {
    isActive(): boolean {
      throw new Error('unavailable');
    },
  };

  assert.equal(isKillSwitchActive(provider), true);
});

test('FileStateProvider has the expected default path without reading it', () => {
  const provider = new FileStateProvider();

  assert.equal(provider.stopFilePath, join(homedir(), '.freerdc', 'STOP'));
});

test('kill-switch calls do not create files or directories', () => {
  const directory = temporaryDirectory();
  const before = readdirSync(directory);
  const provider = new FileStateProvider(join(directory, 'STOP'));

  assert.equal(provider.isActive(), false);
  assert.equal(isKillSwitchActive(provider), false);
  assert.equal(isKillSwitchActive(new InMemoryStateProvider()), false);
  assert.deepEqual(readdirSync(directory), before);
});
