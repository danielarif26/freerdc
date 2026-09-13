import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  E_KILLSWITCH,
  E_PATH_DENIED,
  E_PATH_ESCAPE,
  E_STALE_HASH,
  E_TOO_LARGE,
  FreeRdcError,
} from '@freerdc/protocol';

import { InMemoryStateProvider, SafeFilesystem } from '../src/index.js';

function inTemporaryDirectory(name: string, body: (directory: string) => void): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-filesystem-mutation-${name}-`)));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function expectErrorCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FreeRdcError);
    assert.equal(error.code, code);
    return true;
  });
}

test('SafeFilesystem.mkdir creates a directory and plans without creating one', () => {
  inTemporaryDirectory('mkdir', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    const filesystem = new SafeFilesystem({ roots: [root] });
    const created = join(root, 'created');
    const planned = join(root, 'planned');

    assert.deepEqual(filesystem.mkdir(created), { operation: 'mkdir', path: created, planned: false });
    assert.equal(existsSync(created), true);
    assert.deepEqual(filesystem.mkdir(planned, { dryRun: 'plan' }), {
      operation: 'mkdir', path: planned, planned: true,
    });
    assert.equal(existsSync(planned), false);
  });
});

test('SafeFilesystem.write creates Buffer and string files, but enforces its write limit', () => {
  inTemporaryDirectory('new-write', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    const filesystem = new SafeFilesystem({ roots: [root] });
    const bufferFile = join(root, 'buffer.bin');
    const stringFile = join(root, 'string.txt');

    assert.deepEqual(filesystem.write(bufferFile, Buffer.from([0, 1, 2])), {
      operation: 'write', path: bufferFile, planned: false,
    });
    assert.deepEqual(readFileSync(bufferFile), Buffer.from([0, 1, 2]));
    filesystem.write(stringFile, 'text');
    assert.equal(readFileSync(stringFile, 'utf8'), 'text');
    expectErrorCode(
      () => new SafeFilesystem({ roots: [root], limits: { maxWriteBytes: 3 } }).write(join(root, 'large'), 'four'),
      E_TOO_LARGE,
    );
  });
});

test('SafeFilesystem.write requires the exact SHA-256 to overwrite and rejects one for a new file', () => {
  inTemporaryDirectory('write-hash', (directory) => {
    const root = join(directory, 'root');
    const file = join(root, 'file.txt');
    mkdirSync(root);
    writeFileSync(file, 'before');
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.write(file, 'missing hash'), E_STALE_HASH);
    expectErrorCode(() => filesystem.write(file, 'wrong hash', { expectedSha256: sha256('wrong') }), E_STALE_HASH);
    assert.equal(readFileSync(file, 'utf8'), 'before');
    filesystem.write(file, 'after', { expectedSha256: sha256('before') });
    assert.equal(readFileSync(file, 'utf8'), 'after');
    expectErrorCode(
      () => filesystem.write(join(root, 'new.txt'), 'new', { expectedSha256: sha256('not-present') }),
      E_STALE_HASH,
    );
  });
});

test('SafeFilesystem plans overwrite, delete, and move without changing files', () => {
  inTemporaryDirectory('mutation-plans', (directory) => {
    const root = join(directory, 'root');
    const overwrite = join(root, 'overwrite.txt');
    const deleted = join(root, 'delete.txt');
    const source = join(root, 'source.txt');
    const destination = join(root, 'destination.txt');
    mkdirSync(root);
    writeFileSync(overwrite, 'before');
    writeFileSync(deleted, 'delete');
    writeFileSync(source, 'move');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.equal(filesystem.write(overwrite, 'after', { expectedSha256: sha256('before'), dryRun: 'plan' }).planned, true);
    assert.equal(filesystem.deleteFile(deleted, { expectedSha256: sha256('delete'), dryRun: 'plan' }).planned, true);
    assert.equal(filesystem.moveFile(source, destination, { expectedSha256: sha256('move'), dryRun: 'plan' }).planned, true);
    assert.equal(readFileSync(overwrite, 'utf8'), 'before');
    assert.equal(readFileSync(deleted, 'utf8'), 'delete');
    assert.equal(readFileSync(source, 'utf8'), 'move');
    assert.equal(existsSync(destination), false);
  });
});

test('SafeFilesystem.deleteFile requires the exact hash and only deletes regular files', () => {
  inTemporaryDirectory('delete', (directory) => {
    const root = join(directory, 'root');
    const file = join(root, 'file.txt');
    const childDirectory = join(root, 'directory');
    mkdirSync(root);
    writeFileSync(file, 'delete me');
    mkdirSync(childDirectory);
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.deleteFile(file, {} as never), E_STALE_HASH);
    expectErrorCode(() => filesystem.deleteFile(file, { expectedSha256: sha256('wrong') }), E_STALE_HASH);
    expectErrorCode(() => filesystem.deleteFile(childDirectory, { expectedSha256: sha256('anything') }), E_PATH_ESCAPE);
    assert.equal(existsSync(childDirectory), true);
    assert.deepEqual(filesystem.deleteFile(file, { expectedSha256: sha256('delete me') }), {
      operation: 'deleteFile', path: file, planned: false,
    });
    assert.equal(existsSync(file), false);
  });
});

test('SafeFilesystem.moveFile requires the exact hash, cannot overwrite, and only moves files', () => {
  inTemporaryDirectory('move', (directory) => {
    const root = join(directory, 'root');
    const source = join(root, 'source.txt');
    const destination = join(root, 'destination.txt');
    const occupied = join(root, 'occupied.txt');
    const childDirectory = join(root, 'directory');
    mkdirSync(root);
    writeFileSync(source, 'move me');
    writeFileSync(occupied, 'occupied');
    mkdirSync(childDirectory);
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.moveFile(source, destination, {} as never), E_STALE_HASH);
    expectErrorCode(() => filesystem.moveFile(source, destination, { expectedSha256: sha256('wrong') }), E_STALE_HASH);
    expectErrorCode(() => filesystem.moveFile(source, occupied, { expectedSha256: sha256('move me') }), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.moveFile(childDirectory, destination, { expectedSha256: sha256('anything') }), E_PATH_ESCAPE);
    assert.equal(existsSync(childDirectory), true);
    assert.deepEqual(filesystem.moveFile(source, destination, { expectedSha256: sha256('move me') }), {
      operation: 'moveFile', path: destination, source, destination, planned: false,
    });
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(destination, 'utf8'), 'move me');
  });
});

test('SafeFilesystem mutation methods reject symlink, outside, traversal, and denied paths', () => {
  inTemporaryDirectory('unsafe-paths', (directory) => {
    const root = join(directory, 'root');
    const outside = join(directory, 'outside');
    const file = join(root, 'file.txt');
    const link = join(root, 'link.txt');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(file, 'content');
    writeFileSync(join(outside, 'outside.txt'), 'outside');
    symlinkSync(file, link, 'file');
    const filesystem = new SafeFilesystem({ roots: [root] });
    const hash = sha256('content');
    const denied = join(homedir(), '.ssh', 'freerdc-mutation-must-not-be-accessed');

    expectErrorCode(() => filesystem.mkdir(join(outside, 'directory')), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.write(join(root, '..', 'outside', 'file.txt'), 'outside'), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.deleteFile(join(outside, 'outside.txt'), { expectedSha256: hash }), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.moveFile(file, join(outside, 'moved.txt'), { expectedSha256: hash }), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.write(denied, 'denied'), E_PATH_DENIED);
    expectErrorCode(() => filesystem.write(link, 'linked'), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.deleteFile(link, { expectedSha256: hash }), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.moveFile(link, join(root, 'moved-link.txt'), { expectedSha256: hash }), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.moveFile(file, link, { expectedSha256: hash }), E_PATH_ESCAPE);
    assert.equal(readFileSync(file, 'utf8'), 'content');
  });
});

test('SafeFilesystem rejects invalid dry-run values and never creates missing parents', () => {
  inTemporaryDirectory('invalid-options', (directory) => {
    const root = join(directory, 'root');
    mkdirSync(root);
    const filesystem = new SafeFilesystem({ roots: [root] });
    const nested = join(root, 'missing', 'file.txt');

    expectErrorCode(() => filesystem.mkdir(join(root, 'invalid'), { dryRun: 'invalid' as never }), E_PATH_ESCAPE);
    expectErrorCode(() => filesystem.write(nested, 'content'), E_PATH_ESCAPE);
    assert.equal(existsSync(join(root, 'missing')), false);
  });
});

test('SafeFilesystem kill switch blocks every mutation method', () => {
  inTemporaryDirectory('kill-switch', (directory) => {
    const root = join(directory, 'root');
    const file = join(root, 'file.txt');
    mkdirSync(root);
    writeFileSync(file, 'content');
    const filesystem = new SafeFilesystem({ roots: [root], stateProvider: new InMemoryStateProvider(true) });
    const hash = sha256('content');

    expectErrorCode(() => filesystem.mkdir(join(root, 'directory')), E_KILLSWITCH);
    expectErrorCode(() => filesystem.write(join(root, 'new.txt'), 'new'), E_KILLSWITCH);
    expectErrorCode(() => filesystem.deleteFile(file, { expectedSha256: hash }), E_KILLSWITCH);
    expectErrorCode(() => filesystem.moveFile(file, join(root, 'moved.txt'), { expectedSha256: hash }), E_KILLSWITCH);
    assert.equal(readFileSync(file, 'utf8'), 'content');
  });
});


test("SafeFilesystem hash-guarded mutations stream files above maxReadBytes", () => {
  inTemporaryDirectory("hash-read-limit", (directory) => {
    const root = join(directory, "root"); mkdirSync(root);
    const content = Buffer.alloc(64, 7);
    const file = join(root, "large.bin");
    const deleted = join(root, "deleted.bin");
    const source = join(root, "source.bin");
    writeFileSync(file, content);
    writeFileSync(deleted, content);
    writeFileSync(source, content);
    const filesystem = new SafeFilesystem({ roots: [root], limits: { maxReadBytes: 16 } });
    const hash = sha256(content);
    filesystem.write(file, "new", { expectedSha256: hash });
    assert.equal(readFileSync(file, "utf8"), "new");
    filesystem.deleteFile(deleted, { expectedSha256: hash });
    assert.equal(existsSync(deleted), false);
    const moved = join(root, "moved.bin");
    filesystem.moveFile(source, moved, { expectedSha256: hash });
    assert.deepEqual(readFileSync(moved), content);
  });
});
