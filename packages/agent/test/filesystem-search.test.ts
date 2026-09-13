import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { E_KILLSWITCH, E_PATH_ESCAPE, FreeRdcError } from '@freerdc/protocol';

import { InMemoryStateProvider, SafeFilesystem } from '../src/index.js';

function inTemporaryDirectory(name: string, body: (directory: string) => void): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-filesystem-search-${name}-`)));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function expectErrorCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FreeRdcError);
    assert.equal(error.code, code);
    return true;
  });
}

test('SafeFilesystem.search finds literal non-overlapping matches and is case-insensitive by default', () => {
  inTemporaryDirectory('literal-default-case', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'alpha.txt'), 'Needle needle NEEDLE; neeDle. aaa');
    writeFileSync(join(root, 'beta.txt'), 'aaaa');
    const filesystem = new SafeFilesystem({ roots: [root] });

    const result = filesystem.search(root, 'needle');
    assert.deepEqual(result, {
      matches: [{ path: join(root, 'alpha.txt'), matchCount: 4 }],
      truncated: false,
    });
    assert.deepEqual(filesystem.search(root, 'aa'), {
      matches: [{ path: join(root, 'alpha.txt'), matchCount: 1 }, { path: join(root, 'beta.txt'), matchCount: 2 }],
      truncated: false,
    });
  });
});

test('SafeFilesystem.search honors caseSensitive true', () => {
  inTemporaryDirectory('case-sensitive', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'mixed.txt'), 'Needle needle NEEDLE');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.deepEqual(filesystem.search(root, 'needle', { caseSensitive: true }), {
      matches: [{ path: join(root, 'mixed.txt'), matchCount: 1 }],
      truncated: false,
    });
  });
});

test('SafeFilesystem.search returns paths in deterministic lexical traversal order and honors maxDepth', () => {
  inTemporaryDirectory('order-and-depth', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(join(root, 'alpha', 'nested'), { recursive: true });
    mkdirSync(join(root, 'bravo'));
    writeFileSync(join(root, 'root.txt'), 'match');
    writeFileSync(join(root, 'alpha', 'first.txt'), 'match');
    writeFileSync(join(root, 'alpha', 'nested', 'too-deep.txt'), 'match');
    writeFileSync(join(root, 'bravo', 'second.txt'), 'match');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.deepEqual(
      filesystem.search(root, 'match').matches.map((match) => match.path.slice(root.length + 1)),
      ['root.txt', 'alpha/first.txt', 'alpha/nested/too-deep.txt', 'bravo/second.txt'],
    );
    assert.deepEqual(
      filesystem.search(root, 'match', { maxDepth: 1 }).matches.map((match) => match.path.slice(root.length + 1)),
      ['root.txt', 'alpha/first.txt', 'bravo/second.txt'],
    );
    assert.deepEqual(
      filesystem.search(root, 'match', { maxDepth: 0 }).matches.map((match) => match.path.slice(root.length + 1)),
      ['root.txt'],
    );
  });
});

test('SafeFilesystem.search truncates at maxSearchResults', () => {
  inTemporaryDirectory('result-limit', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'alpha.txt'), 'match');
    writeFileSync(join(root, 'bravo.txt'), 'match');
    writeFileSync(join(root, 'charlie.txt'), 'match');
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxSearchResults: 2 } });

    assert.deepEqual(filesystem.search(root, 'match'), {
      matches: [
        { path: join(root, 'alpha.txt'), matchCount: 1 },
        { path: join(root, 'bravo.txt'), matchCount: 1 },
      ],
      truncated: true,
    });
  });
});

test('SafeFilesystem.search stops cumulatively before reading a file over maxSearchBytes', () => {
  inTemporaryDirectory('byte-limit', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'alpha.txt'), 'match');
    writeFileSync(join(root, 'bravo.txt'), 'match!');
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxSearchBytes: 10 } });

    assert.deepEqual(filesystem.search(root, 'match'), {
      matches: [{ path: join(root, 'alpha.txt'), matchCount: 1 }],
      truncated: true,
    });
  });
});

test('SafeFilesystem.search never returns JSON exceeding maxOutputBytes', () => {
  inTemporaryDirectory('output-limit', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'entry.txt'), 'match');
    const unbounded = new SafeFilesystem({ roots: [root] }).search(root, 'match');
    const budget = Buffer.byteLength(JSON.stringify({ matches: unbounded.matches, truncated: false }));
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxOutputBytes: budget } });

    const result = filesystem.search(root, 'match');
    assert.ok(result.matches.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
  });
});

test('SafeFilesystem.search searches safe file symlinks but never traverses directory symlinks', () => {
  inTemporaryDirectory('symlinks', (directory) => {
    const root = join(directory, 'root');
    const targetDirectory = join(root, 'target-directory');
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(join(root, 'target.txt'), 'match');
    writeFileSync(join(targetDirectory, 'hidden.txt'), 'match');
    symlinkSync(join(root, 'target.txt'), join(root, 'file-link.txt'), 'file');
    symlinkSync(targetDirectory, join(root, 'directory-link'), 'dir');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.deepEqual(
      filesystem.search(root, 'match').matches.map((match) => match.path.slice(root.length + 1)),
      ['file-link.txt', 'target.txt', 'target-directory/hidden.txt'],
    );
  });
});

test('SafeFilesystem.search rejects unsafe roots and invalid needles with E_PATH_ESCAPE', () => {
  inTemporaryDirectory('invalid-input', (directory) => {
    const root = join(directory, 'root');
    const outside = join(directory, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.search(outside, 'match'), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.search('relative-root', 'match'), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.search(`${root}\0suffix`, 'match'), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.search(root, ''), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.search(root, 'needle\0suffix'), E_PATH_ESCAPE);
  });
});

test('SafeFilesystem.search is blocked by the kill switch', () => {
  inTemporaryDirectory('kill-switch', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'entry.txt'), 'match');
    const filesystem = new SafeFilesystem({
      roots: [root],
      stateProvider: new InMemoryStateProvider(true),
    });

    expectErrorCode(() => filesystem.search(root, 'match'), E_KILLSWITCH);
  });
});
