import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test from 'node:test';

import {
  E_KILLSWITCH,
  E_PATH_DENIED,
  E_PATH_ESCAPE,
  E_TOO_LARGE,
  FreeRdcError,
} from '@freerdc/protocol';

import { InMemoryStateProvider, SafeFilesystem } from '../src/index.js';

function inTemporaryDirectory(name: string, body: (directory: string) => void): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-filesystem-${name}-`)));
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

test('SafeFilesystem rejects empty, relative, missing, and non-directory roots', () => {
  inTemporaryDirectory('invalid-root', (directory) => {
    const file = join(directory, 'not-a-directory');
    writeFileSync(file, 'file');

    expectErrorCode(() => new SafeFilesystem({ roots: [] }), E_PATH_ESCAPE);
    expectErrorCode(() => new SafeFilesystem({ roots: ['relative-root'] }), E_PATH_ESCAPE);
    expectErrorCode(() => new SafeFilesystem({ roots: [join(directory, 'missing')] }), E_PATH_ESCAPE);
    expectErrorCode(() => new SafeFilesystem({ roots: [file] }), E_PATH_ESCAPE);
  });
});

test('SafeFilesystem rejects filesystem, home, and home-ancestor roots', () => {
  const home = homedir();
  const filesystemRoot = parse(home).root;

  expectErrorCode(() => new SafeFilesystem({ roots: [filesystemRoot] }), E_PATH_DENIED);
  expectErrorCode(() => new SafeFilesystem({ roots: [home] }), E_PATH_DENIED);
  expectErrorCode(() => new SafeFilesystem({ roots: [join(home, '..')] }), E_PATH_DENIED);
});

test('SafeFilesystem accepts narrow roots below home and unrelated absolute roots', () => {
  const homeRoot = realpathSync(mkdtempSync(join(homedir(), '.freerdc-allowed-root-')));
  const unrelatedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'freerdc-allowed-root-')));
  try {
    assert.doesNotThrow(() => new SafeFilesystem({ roots: [homeRoot] }));
    assert.doesNotThrow(() => new SafeFilesystem({ roots: [unrelatedRoot] }));
  } finally {
    rmSync(homeRoot, { recursive: true, force: true, maxRetries: 3 });
    rmSync(unrelatedRoot, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('SafeFilesystem canonicalizes duplicate symlink roots', () => {
  inTemporaryDirectory('canonical-root', (directory) => {
    const root = join(directory, 'root');
    const rootAlias = join(directory, 'root-alias');
    mkdirSync(root);
    writeFileSync(join(root, 'inside.txt'), 'inside');
    symlinkSync(root, rootAlias, 'dir');

    const filesystem = new SafeFilesystem({ roots: [rootAlias, root] });

    assert.equal(filesystem.read(join(root, 'inside.txt')).toString(), 'inside');
  });
});

test('SafeFilesystem stats, reads, and lists normal in-root files deterministically', () => {
  inTemporaryDirectory('normal-operations', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'beta.txt'), 'beta');
    writeFileSync(join(root, 'alpha.txt'), 'alpha');
    mkdirSync(join(root, 'directory'));
    const filesystem = new SafeFilesystem({ roots: [root] });

    const entry = filesystem.stat(join(root, 'alpha.txt'));
    assert.equal(entry.path, join(root, 'alpha.txt'));
    assert.equal(entry.type, 'file');
    assert.equal(entry.size, Buffer.byteLength('alpha'));
    assert.ok(entry.mtimeMs > 0);
    assert.equal(filesystem.read(join(root, 'beta.txt')).toString(), 'beta');
    assert.deepEqual(
      filesystem.list(root).entries.map((child) => child.path.slice(root.length + 1)),
      ['alpha.txt', 'beta.txt', 'directory'],
    );
  });
});

test('SafeFilesystem rejects reads exceeding either read or output limits', () => {
  inTemporaryDirectory('read-limits', (directory) => {
    const root = join(directory, 'root');
    const file = join(root, 'four-bytes.txt');
    mkdirSync(root);
    writeFileSync(file, 'four');

    expectErrorCode(
      () => new SafeFilesystem({ roots: [root], limits: { maxReadBytes: 3 } }).read(file),
      E_TOO_LARGE,
    );
    expectErrorCode(
      () => new SafeFilesystem({ roots: [root], limits: { maxOutputBytes: 3 } }).read(file),
      E_TOO_LARGE,
    );
  });
});

test('SafeFilesystem rejects outside, traversal, and NUL candidates', () => {
  inTemporaryDirectory('unsafe-candidates', (directory) => {
    const root = join(directory, 'root');
    const outside = join(directory, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'outside.txt'), 'outside');
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.stat(join(outside, 'outside.txt')), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.stat(join(root, '..', 'outside', 'outside.txt')), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.stat(`${root}/nul\0candidate`), E_PATH_ESCAPE);
  });
});

test('SafeFilesystem rejects a denied string before protected-location filesystem access', () => {
  inTemporaryDirectory('denied-candidate', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    const filesystem = new SafeFilesystem({ roots: [root] });
    const protectedCandidate = join(homedir(), '.ssh', 'freerdc-must-not-be-read');

    expectErrorCode(() => filesystem.stat(protectedCandidate), E_PATH_DENIED);
  });
});

test('SafeFilesystem rejects symlinks that resolve outside a root', () => {
  inTemporaryDirectory('outside-symlink', (directory) => {
    const root = join(directory, 'root');
    const outside = join(directory, 'outside.txt');
    const link = join(root, 'outside-link');
    mkdirSync(root);
    writeFileSync(outside, 'outside');
    symlinkSync(outside, link, 'file');
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.stat(link), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.read(link), E_PATH_ESCAPE);
  });
});

test('SafeFilesystem reports safe in-root symlinks and reads through them', () => {
  inTemporaryDirectory('inside-symlink', (directory) => {
    const root = join(directory, 'root');
    const target = join(root, 'target.txt');
    const link = join(root, 'inside-link');
    mkdirSync(root);
    writeFileSync(target, 'linked content');
    symlinkSync(target, link, 'file');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.equal(filesystem.stat(link).type, 'symlink');
    assert.equal(filesystem.read(link).toString(), 'linked content');
  });
});

test('SafeFilesystem omits unsafe symlink children from a directory listing', () => {
  inTemporaryDirectory('unsafe-list-child', (directory) => {
    const root = join(directory, 'root');
    const outside = join(directory, 'outside.txt');
    mkdirSync(root);
    writeFileSync(join(root, 'safe.txt'), 'safe');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, join(root, 'unsafe-link'), 'file');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.deepEqual(
      filesystem.list(root).entries.map((entry) => entry.path.slice(root.length + 1)),
      ['safe.txt'],
    );
  });
});

test('SafeFilesystem kill switch blocks stat, read, and list', () => {
  inTemporaryDirectory('kill-switch', (directory) => {
    const root = join(directory, 'root');
    const file = join(root, 'file.txt');
    mkdirSync(root);
    writeFileSync(file, 'content');
    const filesystem = new SafeFilesystem({
      roots: [root],
      stateProvider: new InMemoryStateProvider(true),
    });

    expectErrorCode(() => filesystem.stat(file), E_KILLSWITCH);
    expectErrorCode(() => filesystem.read(file), E_KILLSWITCH);
    expectErrorCode(() => filesystem.list(root), E_KILLSWITCH);
  });
});

test('SafeFilesystem truncates lists at maxSearchResults', () => {
  inTemporaryDirectory('result-limit', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'alpha.txt'), 'a');
    writeFileSync(join(root, 'bravo.txt'), 'b');
    writeFileSync(join(root, 'charlie.txt'), 'c');
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxSearchResults: 2 } });

    const result = filesystem.list(root);
    assert.equal(result.truncated, true);
    assert.deepEqual(
      result.entries.map((entry) => entry.path.slice(root.length + 1)),
      ['alpha.txt', 'bravo.txt'],
    );
  });
});

test('SafeFilesystem returns a truncated empty list when an entry cannot fit output budget', () => {
  inTemporaryDirectory('tight-output-limit', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'entry.txt'), 'entry');
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxOutputBytes: 1 } });

    const result = filesystem.list(root);
    assert.deepEqual(result.entries, []);
    assert.equal(result.truncated, true);
  });
});

test('SafeFilesystem never returns entries whose JSON result exceeds maxOutputBytes', () => {
  inTemporaryDirectory('exact-output-limit', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    writeFileSync(join(root, 'entry.txt'), 'entry');
    const unbounded = new SafeFilesystem({ roots: [root] }).list(root);
    const requiredBytes = Buffer.byteLength(JSON.stringify({
      entries: unbounded.entries,
      truncated: false,
    }));
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxOutputBytes: requiredBytes } });

    const result = filesystem.list(root);
    assert.ok(result.entries.length > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= requiredBytes);
  });
});
