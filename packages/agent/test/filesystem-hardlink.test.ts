import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { E_PATH_DENIED, E_STALE_HASH, FreeRdcError } from '@freerdc/protocol';

import { SafeFilesystem } from '../src/filesystem.js';

/** A synthetic home containing a private ~/.freerdc state directory plus an exposed work root. */
function inSyntheticHome(name: string, body: (home: { home: string; root: string }) => void): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-hardlink-${name}-`)));
  try {
    const root = join(home, 'work');
    mkdirSync(join(home, '.freerdc'), { recursive: true });
    mkdirSync(root, { recursive: true });
    body({ home, root });
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function expectErrorCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FreeRdcError);
    assert.equal(error.code, code);
    return true;
  });
}

test('a hard link to a file outside the root is denied for read by default', () => {
  inSyntheticHome('read', ({ home, root }) => {
    const secret = join(home, '.freerdc', 'sample.txt');
    const innocent = join(root, 'innocent.txt');
    writeFileSync(secret, 'private state material');
    linkSync(secret, innocent);
    assert.equal(statSync(innocent).nlink, 2);

    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.read(innocent), E_PATH_DENIED);
    expectErrorCode(() => filesystem.stat(innocent), E_PATH_DENIED);
    // The bytes are still readable outside the API: only the confined view denies.
    assert.equal(readFileSync(innocent, 'utf8'), 'private state material');
  });
});

test('a hard link to a file outside the root is denied for every mutation by default', () => {
  inSyntheticHome('mutate', ({ home, root }) => {
    const secret = join(home, '.freerdc', 'sample.txt');
    const innocent = join(root, 'innocent.txt');
    const inside = join(root, 'notes.txt');
    writeFileSync(secret, 'private state material');
    linkSync(secret, innocent);
    const filesystem = new SafeFilesystem({ roots: [root] });
    const secretHash = sha256('private state material');

    filesystem.write(inside, 'ordinary content');
    const insideHash = sha256('ordinary content');

    expectErrorCode(() => filesystem.write(innocent, 'overwritten', { expectedSha256: secretHash }), E_PATH_DENIED);
    expectErrorCode(() => filesystem.deleteFile(innocent, { expectedSha256: secretHash }), E_PATH_DENIED);
    expectErrorCode(
      () => filesystem.moveFile(innocent, join(root, 'moved.txt'), { expectedSha256: secretHash }),
      E_PATH_DENIED,
    );
    expectErrorCode(
      () => filesystem.moveFile(inside, innocent, { expectedSha256: insideHash }),
      E_PATH_DENIED,
    );
    expectErrorCode(() => filesystem.write(innocent, 'overwritten'), E_PATH_DENIED);
    expectErrorCode(() => filesystem.write(innocent, 'overwritten', { dryRun: 'plan' }), E_PATH_DENIED);
    expectErrorCode(() => filesystem.deleteFile(innocent, { expectedSha256: secretHash, dryRun: 'plan' }), E_PATH_DENIED);

    assert.equal(readFileSync(innocent, 'utf8'), 'private state material');
    assert.equal(readFileSync(secret, 'utf8'), 'private state material');
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'ordinary content');
    assert.equal(lstatSync(innocent).isFile(), true);
  });
});

test('a hard link between two files inside the root is denied by default', () => {
  inSyntheticHome('both-inside', ({ root }) => {
    const original = join(root, 'original.txt');
    const alias = join(root, 'alias.txt');
    writeFileSync(original, 'shared bytes');
    linkSync(original, alias);
    const filesystem = new SafeFilesystem({ roots: [root] });

    expectErrorCode(() => filesystem.read(alias), E_PATH_DENIED);
    expectErrorCode(() => filesystem.write(alias, 'rewritten', { expectedSha256: sha256('shared bytes') }), E_PATH_DENIED);
  });
});

test('a multiply-linked file is skipped by search instead of leaking a match count', () => {
  inSyntheticHome('search', ({ home, root }) => {
    const secret = join(home, '.freerdc', 'sample.txt');
    const innocent = join(root, 'innocent.txt');
    writeFileSync(secret, 'needle in the haystack');
    linkSync(secret, innocent);
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.equal(filesystem.search(root, 'needle').matches.length, 0);
  });
});

test('the allowMultiplyLinkedFiles opt-out restores hard link access', () => {
  inSyntheticHome('opt-out', ({ home, root }) => {
    const secret = join(home, '.freerdc', 'sample.txt');
    const innocent = join(root, 'innocent.txt');
    writeFileSync(secret, 'private state material');
    linkSync(secret, innocent);
    const filesystem = new SafeFilesystem({ roots: [root], allowMultiplyLinkedFiles: true });

    assert.equal(filesystem.read(innocent).toString(), 'private state material');
    filesystem.write(innocent, 'rewritten', { expectedSha256: sha256('private state material') });
    assert.equal(readFileSync(secret, 'utf8'), 'rewritten');
  });
});

test('a stale expected hash is still reported for single-link files', () => {
  inSyntheticHome('single-link', ({ root }) => {
    const file = join(root, 'notes.txt');
    writeFileSync(file, 'content');
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.equal(statSync(file).nlink, 1);
    expectErrorCode(
      () => filesystem.write(file, 'replacement', { expectedSha256: sha256('stale') }),
      E_STALE_HASH,
    );
  });
});

test('ordinary single-link files are unaffected by the hard link check', () => {
  inSyntheticHome('single-link-unaffected', ({ home, root }) => {
    const file = join(root, 'notes.txt');
    const nested = join(root, 'nested');
    writeFileSync(file, 'first revision');
    mkdirSync(nested);
    const filesystem = new SafeFilesystem({ roots: [root] });

    assert.equal(filesystem.read(file).toString(), 'first revision');
    filesystem.write(file, 'second revision', { expectedSha256: sha256('first revision') });
    assert.equal(filesystem.read(file).toString(), 'second revision');

    const entry = filesystem.stat(file);
    assert.equal(entry.type, 'file');
    assert.equal(entry.size, Buffer.byteLength('second revision'));

    assert.equal(filesystem.search(root, 'second').matches.length, 1);

    const moved = join(root, 'moved.txt');
    filesystem.moveFile(file, moved, { expectedSha256: sha256('second revision') });
    assert.equal(filesystem.read(moved).toString(), 'second revision');
    assert.equal(lstatSync(file, { throwIfNoEntry: false }), undefined);

    const nestedFile = join(nested, 'new file');
    filesystem.write(nestedFile, 'new file');
    assert.equal(filesystem.read(nestedFile).toString(), 'new file');
    filesystem.deleteFile(nestedFile, { expectedSha256: sha256('new file') });
    assert.equal(lstatSync(nestedFile, { throwIfNoEntry: false }), undefined);
    // The synthetic home's private state directory is never created as a side effect.
    assert.equal(readFileSync(join(home, '.freerdc', 'sample.txt'), { flag: 'a+' }).toString(), '');
  });
});
