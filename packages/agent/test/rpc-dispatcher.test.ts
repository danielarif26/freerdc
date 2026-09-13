import { test, describe, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { RpcDispatcher, type RpcErrorWire } from '../src/rpc/dispatcher.js';
import { SafeFilesystem, type SafeFilesystemEntry } from '../src/filesystem.js';
import { ProcessManager, type CommandPolicy } from '../src/index.js';
import { encodeWireBytes, decodeWireBytes } from '../src/rpc/encoding.js';
import {
  parseEnvelope,
  FreeRdcError,
  E_MALFORMED_MESSAGE,
  E_CAPABILITY_UNSUPPORTED,
  E_INTERNAL,
  E_CONCURRENCY_LIMIT,
  E_DEVICE_OFFLINE,
} from '@freerdc/protocol';

class RecordingResponder {
  results = new Map<string, unknown>();
  errors = new Map<string, RpcErrorWire>();

  sendResult(requestId: string, result: unknown): void {
    this.results.set(requestId, result);
  }

  sendError(requestId: string, error: RpcErrorWire): void {
    this.errors.set(requestId, error);
  }
}

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makeRpcRequest(requestId: string, method: string, params: unknown) {
  return parseEnvelope({
    v: 'freerdc-wire/1',
    id: requestId,
    kind: 'rpc.req',
    ts: Date.now(),
    payload: { type: 'rpc.req', requestId, method, params },
  });
}

function makeCancelRequest(requestId: string) {
  return parseEnvelope({
    v: 'freerdc-wire/1',
    id: requestId,
    kind: 'cancel',
    ts: Date.now(),
    payload: { type: 'cancel', requestId },
  });
}

function makePingRequest(requestId: string) {
  return parseEnvelope({
    v: 'freerdc-wire/1',
    id: requestId,
    kind: 'ping',
    ts: Date.now(),
    payload: { type: 'ping' },
  });
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

const NODE = realpathSync(process.execPath);
const NODE_BASENAME = basename(NODE);

function allowNodeDashE(): CommandPolicy {
  return { rules: [{ executable: NODE, basename: NODE_BASENAME, argv: (argv) => argv[0] === '-e' }] };
}

describe('RpcDispatcher', () => {
  let root: string;
  let fs: SafeFilesystem;
  let dispatcher: RpcDispatcher;
  let responder: RecordingResponder;
  let requestId = 0;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'rpc-dispatcher-test-')));
    fs = new SafeFilesystem({ roots: [root] });
    responder = new RecordingResponder();
    dispatcher = new RpcDispatcher({ filesystem: fs, responder });
    requestId = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('filesystem RPC methods round-trip', () => {
    test('fs.write -> fs.read binary round-trip with SHA hash', async () => {
      const data = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0xfe, 0xfd]);
      const content = encodeWireBytes(data);
      const writeId = `req-${++requestId}`;

      dispatcher.handleFrame(makeRpcRequest(writeId, 'fs.write', { path: join(root, 'file.bin'), content, dryRun: 'off' }));
      await flush();

      assert.ok(responder.results.has(writeId), 'write should succeed');
      const writeResult = responder.results.get(writeId);
      assert.deepEqual(writeResult, { operation: 'write', path: join(root, 'file.bin'), planned: false });

      const readId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(readId, 'fs.read', { path: join(root, 'file.bin') }));
      await flush();

      assert.ok(responder.results.has(readId), 'read should succeed');
      const readResult = responder.results.get(readId) as { content: { encoding: string; data: string } };
      assert.deepEqual(decodeWireBytes(readResult.content), data);
    });

    test('fs.write with expectedSha256 overwrite', async () => {
      const data1 = Buffer.from('first version');
      const data2 = Buffer.from('second version');
      const content1 = encodeWireBytes(data1);
      const content2 = encodeWireBytes(data2);
      const hash1 = sha256(data1);
      const hash2 = sha256(data2);

      // Write first version
      const writeId1 = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId1, 'fs.write', { path: join(root, 'overwrite.txt'), content: content1, dryRun: 'off' }));
      await flush();
      assert.ok(responder.results.has(writeId1));

      // Write second version with expectedSha256 of first
      const writeId2 = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId2, 'fs.write', { path: join(root, 'overwrite.txt'), content: content2, expectedSha256: hash1, dryRun: 'off' }));
      await flush();
      assert.ok(responder.results.has(writeId2));

      // Verify content is now second version
      const readId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(readId, 'fs.read', { path: join(root, 'overwrite.txt') }));
      await flush();
      const readResult = responder.results.get(readId) as { content: { encoding: string; data: string } };
      assert.deepEqual(decodeWireBytes(readResult.content), data2);
    });

    test('fs.stat returns path not name', async () => {
      const data = Buffer.from('stat test');
      const content = encodeWireBytes(data);
      const writeId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId, 'fs.write', { path: join(root, 'stat.txt'), content, dryRun: 'off' }));
      await flush();

      const statId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(statId, 'fs.stat', { path: join(root, 'stat.txt') }));
      await flush();

      assert.ok(responder.results.has(statId));
      const statResult = responder.results.get(statId) as { path: string; type: string; size: number; mtimeMs: number };
      assert.strictEqual(statResult.path, join(root, 'stat.txt'));
      assert.strictEqual(statResult.type, 'file');
      assert.strictEqual(statResult.size, data.length);
      assert.ok(statResult.mtimeMs > 0);
    });

    test('fs.list entries expose path not name', async () => {
      const data = Buffer.from('list test');
      const content = encodeWireBytes(data);
      const writeId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId, 'fs.write', { path: join(root, 'list.txt'), content, dryRun: 'off' }));
      await flush();

      const listId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(listId, 'fs.list', { path: root }));
      await flush();

      assert.ok(responder.results.has(listId));
      const listResult = responder.results.get(listId) as { entries: Array<{ path: string }>; truncated: boolean };
      assert.ok(listResult.entries.length > 0);
      const found = listResult.entries.some((e) => e.path === join(root, 'list.txt'));
      assert.ok(found, 'list entry should have absolute path');
    });

    test('fs.search searches file content with known text needle', async () => {
      const needle = 'UNIQUE_SEARCH_NEEDLE_12345';
      const data = Buffer.from(`This file contains ${needle} inside it.`);
      const content = encodeWireBytes(data);
      const writeId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId, 'fs.write', { path: join(root, 'search.txt'), content, dryRun: 'off' }));
      await flush();

      const searchId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(searchId, 'fs.search', { path: root, query: needle, caseSensitive: true }));
      await flush();

      assert.ok(responder.results.has(searchId));
      const searchResult = responder.results.get(searchId) as { matches: Array<{ path: string; matchCount: number }>; truncated: boolean };
      assert.ok(searchResult.matches.length > 0);
      const found = searchResult.matches.some((m) => m.path === join(root, 'search.txt') && m.matchCount === 1);
      assert.ok(found, 'search should find the needle in file content');
    });

    test('fs.mkdir creates directory', async () => {
      const mkdirId = `req-${++requestId}`;
      const dirPath = join(root, 'newdir');
      dispatcher.handleFrame(makeRpcRequest(mkdirId, 'fs.mkdir', { path: dirPath, dryRun: 'off' }));
      await flush();

      assert.ok(responder.results.has(mkdirId));
      const mkdirResult = responder.results.get(mkdirId) as { operation: string; path: string; planned: boolean };
      assert.strictEqual(mkdirResult.operation, 'mkdir');
      assert.strictEqual(mkdirResult.path, dirPath);
      assert.strictEqual(mkdirResult.planned, false);
    });

    test('fs.delete requires expectedSha256', async () => {
      const data = Buffer.from('delete me');
      const content = encodeWireBytes(data);
      const hash = sha256(data);
      const writeId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId, 'fs.write', { path: join(root, 'delete.txt'), content, dryRun: 'off' }));
      await flush();

      const deleteId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(deleteId, 'fs.delete', { path: join(root, 'delete.txt'), expectedSha256: hash, dryRun: 'off' }));
      await flush();

      assert.ok(responder.results.has(deleteId));
      const deleteResult = responder.results.get(deleteId) as { operation: string; path: string; planned: boolean };
      assert.strictEqual(deleteResult.operation, 'deleteFile');
      assert.strictEqual(deleteResult.path, join(root, 'delete.txt'));
      assert.strictEqual(deleteResult.planned, false);
    });

    test('fs.move requires expectedSha256', async () => {
      const data = Buffer.from('move me');
      const content = encodeWireBytes(data);
      const hash = sha256(data);
      const writeId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(writeId, 'fs.write', { path: join(root, 'move-src.txt'), content, dryRun: 'off' }));
      await flush();

      const moveId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(moveId, 'fs.move', { source: join(root, 'move-src.txt'), destination: join(root, 'move-dst.txt'), expectedSha256: hash, dryRun: 'off' }));
      await flush();

      assert.ok(responder.results.has(moveId));
      const moveResult = responder.results.get(moveId) as { operation: string; path: string; source: string; destination: string; planned: boolean };
      assert.strictEqual(moveResult.operation, 'moveFile');
      assert.strictEqual(moveResult.path, join(root, 'move-dst.txt'));
      assert.strictEqual(moveResult.source, join(root, 'move-src.txt'));
      assert.strictEqual(moveResult.destination, join(root, 'move-dst.txt'));
      assert.strictEqual(moveResult.planned, false);
    });
  });

  describe('error handling', () => {
    test('malformed params -> E_MALFORMED_MESSAGE', async () => {
      const badId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(badId, 'fs.stat', {}));
      await flush();

      assert.ok(responder.errors.has(badId));
      const error = responder.errors.get(badId)!;
      assert.strictEqual(error.code, E_MALFORMED_MESSAGE);
    });

    test('unknown method -> E_CAPABILITY_UNSUPPORTED', async () => {
      const unkId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(unkId, 'fs.unknown', {}));
      await flush();

      assert.ok(responder.errors.has(unkId));
      const error = responder.errors.get(unkId)!;
      assert.strictEqual(error.code, E_CAPABILITY_UNSUPPORTED);
    });

    test('proc.list without ProcessManager -> E_CAPABILITY_UNSUPPORTED', async () => {
      const procId = `req-${++requestId}`;
      dispatcher.handleFrame(makeRpcRequest(procId, 'proc.list', {}));
      await flush();

      assert.ok(responder.errors.has(procId));
      const error = responder.errors.get(procId)!;
      assert.strictEqual(error.code, E_CAPABILITY_UNSUPPORTED);
    });

    test('unknown frame kind is ignored', async () => {
      const unknownFrame = parseEnvelope({
        v: 'freerdc-wire/1',
        id: 'ignored-1',
        kind: 'unknown-kind',
        ts: Date.now(),
        payload: { type: 'unknown-kind' },
      });
      dispatcher.handleFrame(unknownFrame);
      await flush();

      assert.strictEqual(responder.results.size, 0);
      assert.strictEqual(responder.errors.size, 0);
    });

    test('ping frame is ignored', async () => {
      const pingFrame = makePingRequest('ping-1');
      dispatcher.handleFrame(pingFrame);
      await flush();

      assert.strictEqual(responder.results.size, 0);
      assert.strictEqual(responder.errors.size, 0);
    });

    test('raw Error from SafeFilesystem subclass stat override -> E_INTERNAL with no sentinel', async () => {
      class BadFs extends SafeFilesystem {
        override stat(): SafeFilesystemEntry {
          throw new Error('SECRET_SENTINEL');
        }
      }

      const badFs = new BadFs({ roots: [root] });
      const badResponder = new RecordingResponder();
      const badDispatcher = new RpcDispatcher({ filesystem: badFs, responder: badResponder });

      const id = `req-${++requestId}`;
      badDispatcher.handleFrame(makeRpcRequest(id, 'fs.stat', { path: root }));
      await flush();

      assert.ok(badResponder.errors.has(id));
      const error = badResponder.errors.get(id)!;
      assert.deepEqual(error, { code: E_INTERNAL });
      assert.doesNotMatch(JSON.stringify(error), /SECRET_SENTINEL|message|details|path/);
    });

    test('FreeRdcError emits only its canonical code with no message, details, or path leakage', async () => {
      const sentinel = 'SECRET_SENTINEL_KNOWN_ERROR';
      const sentinelPath = join(root, `${sentinel}.txt`);

      class BadFs extends SafeFilesystem {
        override stat(): SafeFilesystemEntry {
          throw new FreeRdcError(
            E_MALFORMED_MESSAGE,
            `${sentinel} message`,
            { details: sentinel, path: sentinelPath },
          );
        }
      }

      const badFs = new BadFs({ roots: [root] });
      const badResponder = new RecordingResponder();
      const badDispatcher = new RpcDispatcher({ filesystem: badFs, responder: badResponder });

      const id = `req-${++requestId}`;
      badDispatcher.handleFrame(makeRpcRequest(id, 'fs.stat', { path: root }));
      await flush();

      const error = badResponder.errors.get(id);
      assert.deepEqual(error, { code: E_MALFORMED_MESSAGE });
      const json = JSON.stringify(error);
      assert.doesNotMatch(json, /SECRET_SENTINEL_KNOWN_ERROR|message|details|path/);
    });

    test('fs.write with non-canonical base64 WireBytes -> E_MALFORMED_MESSAGE, not E_INTERNAL', async () => {
      const badId = `req-${++requestId}`;
      dispatcher.handleFrame(
        makeRpcRequest(badId, 'fs.write', {
          path: join(root, 'bad.bin'),
          content: { encoding: 'base64', data: 'A' },
          dryRun: 'off',
        }),
      );
      await flush();

      assert.ok(responder.errors.has(badId));
      assert.strictEqual(responder.errors.get(badId)!.code, E_MALFORMED_MESSAGE);
    });

    test('proc.input with non-canonical WireBytes -> E_MALFORMED_MESSAGE, not E_INTERNAL', async () => {
      const badId = `req-${++requestId}`;
      dispatcher.handleFrame(
        makeRpcRequest(badId, 'proc.input', {
          id: 'irrelevant-id',
          data: { encoding: 'base64', data: 'A' },
        }),
      );
      await flush();

      assert.ok(responder.errors.has(badId));
      assert.strictEqual(responder.errors.get(badId)!.code, E_MALFORMED_MESSAGE);
    });

    test('runtime-forged non-canonical error code is sanitized to E_INTERNAL with no leakage', async () => {
      const sentinel = 'E_FORGED_SENTINEL_CODE';

      class ForgedCodeError extends FreeRdcError {
        constructor() {
          super(E_MALFORMED_MESSAGE);
          (this as { code: string }).code = sentinel;
        }
      }

      class BadFs extends SafeFilesystem {
        override stat(): SafeFilesystemEntry {
          throw new ForgedCodeError();
        }
      }

      const badFs = new BadFs({ roots: [root] });
      const badResponder = new RecordingResponder();
      const badDispatcher = new RpcDispatcher({ filesystem: badFs, responder: badResponder });

      const id = `req-${++requestId}`;
      badDispatcher.handleFrame(makeRpcRequest(id, 'fs.stat', { path: root }));
      await flush();

      const error = badResponder.errors.get(id);
      assert.deepEqual(error, { code: E_INTERNAL });
      const json = JSON.stringify(error);
      assert.doesNotMatch(json, new RegExp(sentinel));
    });

    test('responder throw does not cause unhandled rejection', async () => {
      const explodingResponder = {
        sendResult() {
          throw new Error('boom');
        },
        sendError() {
          throw new Error('boom');
        },
      };

      const safeDispatcher = new RpcDispatcher({ filesystem: fs, responder: explodingResponder });

      let unhandled = false;
      const handler = () => { unhandled = true; };
      process.once('unhandledRejection', handler);

      const id = `req-${++requestId}`;
      safeDispatcher.handleFrame(makeRpcRequest(id, 'fs.stat', { path: root }));
      await flush();

      process.removeListener('unhandledRejection', handler);
      assert.strictEqual(unhandled, false, 'no unhandled rejection should occur');
    });
  });

  describe('dryRun values', () => {
    test('dryRun plan mode does not mutate', async () => {
      const mkdirId = `req-${++requestId}`;
      const dirPath = join(root, 'plan-dir');
      dispatcher.handleFrame(makeRpcRequest(mkdirId, 'fs.mkdir', { path: dirPath, dryRun: 'plan' }));
      await flush();

      assert.ok(responder.results.has(mkdirId));
      const mkdirResult = responder.results.get(mkdirId) as { operation: string; path: string; planned: boolean };
      assert.strictEqual(mkdirResult.planned, true);
    });
  });

  describe('proc.* RPC methods with a real ProcessManager', () => {
    let procRoot: string;
    let procManager: ProcessManager;
    let procFs: SafeFilesystem;
    let procResponder: RecordingResponder;
    let procDispatcher: RpcDispatcher;

    beforeEach(() => {
      procRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rpc-dispatcher-proc-test-')));
      procFs = new SafeFilesystem({ roots: [procRoot] });
      procManager = new ProcessManager({
        roots: [procRoot],
        policy: allowNodeDashE(),
        baseEnv: { SECRET_VALUE: 'not-visible', ORDINARY_DUMMY: 'kept' },
      });
      procResponder = new RecordingResponder();
      procDispatcher = new RpcDispatcher({ filesystem: procFs, processManager: procManager, responder: procResponder });
    });

    afterEach(async () => {
      procManager.killAll(true);
      await waitFor(() => procManager.list().every((item) => item.status === 'exited'), 'proc test child cleanup did not finish');
      rmSync(procRoot, { recursive: true, force: true, maxRetries: 3 });
    });

    test('proc.start returns a safe summary with no argv or env leakage', async () => {
      const startId = `req-${++requestId}`;
      procDispatcher.handleFrame(
        makeRpcRequest(startId, 'proc.start', {
          executable: NODE,
          argv: ['-e', 'setTimeout(() => {}, 200)', 'private-argv-marker'],
        }),
      );
      await flush();

      assert.ok(procResponder.results.has(startId));
      const result = procResponder.results.get(startId) as { id: string; status: string; startedAt: string };
      assert.deepEqual(Object.keys(result).sort(), ['id', 'startedAt', 'status']);
      assert.strictEqual(result.status, 'running');
      assert.doesNotMatch(JSON.stringify(result), /private-argv-marker|SECRET_VALUE|not-visible/);

      await waitFor(
        () => procManager.list().some((p) => p.id === result.id && p.status === 'exited'),
        'started process did not exit',
      );
    });

    test('proc.list exposes only opaque summaries with no argv or env leakage', async () => {
      const startId = `req-${++requestId}`;
      procDispatcher.handleFrame(
        makeRpcRequest(startId, 'proc.start', {
          executable: NODE,
          argv: ['-e', 'setTimeout(() => {}, 200)', 'private-argv-marker'],
        }),
      );
      await flush();
      const started = procResponder.results.get(startId) as { id: string };

      const listId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(listId, 'proc.list', {}));
      await flush();

      assert.ok(procResponder.results.has(listId));
      const listResult = procResponder.results.get(listId) as { processes: Array<{ id: string; status: string; startedAt: string }> };
      const found = listResult.processes.find((p) => p.id === started.id);
      assert.ok(found, 'started process should appear in proc.list');
      assert.deepEqual(Object.keys(found).sort(), ['id', 'startedAt', 'status']);
      assert.doesNotMatch(JSON.stringify(listResult), /private-argv-marker|SECRET_VALUE|not-visible/);

      await waitFor(
        () => procManager.list().every((p) => p.status === 'exited'),
        'listed process did not exit',
      );
    });

    test('proc.read returns WireBytes-encoded stdout and stderr', async () => {
      const startId = `req-${++requestId}`;
      procDispatcher.handleFrame(
        makeRpcRequest(startId, 'proc.start', {
          executable: NODE,
          argv: ['-e', "process.stdout.write('out-data'); process.stderr.write('err-data');"],
        }),
      );
      await flush();
      const started = procResponder.results.get(startId) as { id: string };

      await waitFor(
        () => procManager.list().some((p) => p.id === started.id && p.status === 'exited'),
        'process did not exit before read',
      );

      const readId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(readId, 'proc.read', { id: started.id }));
      await flush();

      assert.ok(procResponder.results.has(readId));
      const readResult = procResponder.results.get(readId) as {
        stdout: { encoding: string; data: string };
        stderr: { encoding: string; data: string };
        status: string;
        exitCode: number | null;
      };
      assert.deepEqual(decodeWireBytes(readResult.stdout), Buffer.from('out-data'));
      assert.deepEqual(decodeWireBytes(readResult.stderr), Buffer.from('err-data'));
      assert.strictEqual(readResult.status, 'exited');
      assert.strictEqual(readResult.exitCode, 0);
    });

    test('proc.read chunks large output so every wire result stays bounded without data loss', async () => {
      const startId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(startId, 'proc.start', {
        executable: NODE,
        argv: ['-e', "process.stdout.write(Buffer.alloc(100000, 0));"],
      }));
      await flush();
      const started = procResponder.results.get(startId) as { id: string };
      await waitFor(
        () => procManager.list().some((p) => p.id === started.id && p.status === 'exited'),
        'large-output process did not exit',
      );

      const chunks: Buffer[] = [];
      for (;;) {
        const readId = `req-${++requestId}`;
        procDispatcher.handleFrame(makeRpcRequest(readId, 'proc.read', { id: started.id }));
        await flush();
        const readResult = procResponder.results.get(readId) as {
          stdout: { encoding: string; data: string }; stderr: { encoding: string; data: string }; truncated: boolean; hasMore: boolean;
        };
        assert.ok(readResult);
        assert.ok(Buffer.byteLength(JSON.stringify(readResult), 'utf8') < 262_144);
        chunks.push(decodeWireBytes(readResult.stdout), decodeWireBytes(readResult.stderr));
        if (!readResult.hasMore) break;
      }
      assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(100000, 0));
    });

    test('proc.read with unknown id -> E_DEVICE_OFFLINE', async () => {
      const readId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(readId, 'proc.read', { id: 'nonexistent-id' }));
      await flush();

      assert.ok(procResponder.errors.has(readId));
      assert.strictEqual(procResponder.errors.get(readId)!.code, E_DEVICE_OFFLINE);
    });

    test('proc.input writes data that the child echoes back, visible via proc.read', async () => {
      const startId = `req-${++requestId}`;
      procDispatcher.handleFrame(
        makeRpcRequest(startId, 'proc.start', {
          executable: NODE,
          argv: ['-e', "process.stdin.once('data', (data) => { process.stdout.write(data); process.exit(0); })"],
        }),
      );
      await flush();
      const started = procResponder.results.get(startId) as { id: string };

      const inputId = `req-${++requestId}`;
      procDispatcher.handleFrame(
        makeRpcRequest(inputId, 'proc.input', { id: started.id, data: encodeWireBytes(Buffer.from('echo-me')) }),
      );
      await flush();

      assert.ok(procResponder.results.has(inputId));
      assert.deepEqual(procResponder.results.get(inputId), { accepted: true });

      await waitFor(
        () => procManager.list().some((p) => p.id === started.id && p.status === 'exited'),
        'process did not exit after input',
      );

      const readId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(readId, 'proc.read', { id: started.id }));
      await flush();

      const readResult = procResponder.results.get(readId) as { stdout: { encoding: string; data: string } };
      assert.deepEqual(decodeWireBytes(readResult.stdout), Buffer.from('echo-me'));
    });

    test('proc.kill only kills manager-owned ids', async () => {
      const startId = `req-${++requestId}`;
      procDispatcher.handleFrame(
        makeRpcRequest(startId, 'proc.start', { executable: NODE, argv: ['-e', 'setInterval(() => {}, 1000);'] }),
      );
      await flush();
      const started = procResponder.results.get(startId) as { id: string };

      const killId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(killId, 'proc.kill', { id: started.id, force: true }));
      await flush();

      assert.ok(procResponder.results.has(killId));
      assert.deepEqual(procResponder.results.get(killId), { killed: true });

      await waitFor(
        () => procManager.list().some((p) => p.id === started.id && p.status === 'exited'),
        'process did not exit after kill',
      );
    });

    test('proc.kill with unknown id -> E_DEVICE_OFFLINE', async () => {
      const killId = `req-${++requestId}`;
      procDispatcher.handleFrame(makeRpcRequest(killId, 'proc.kill', { id: 'nonexistent-id', force: false }));
      await flush();

      assert.ok(procResponder.errors.has(killId));
      assert.strictEqual(procResponder.errors.get(killId)!.code, E_DEVICE_OFFLINE);
    });
  });

  describe('proc.start concurrency and cancellation with maxInFlight=1', () => {
    let ccRoot: string;
    let ccManager: ProcessManager;
    let ccFs: SafeFilesystem;
    let ccResponder: RecordingResponder;
    let ccDispatcher: RpcDispatcher;

    beforeEach(() => {
      ccRoot = realpathSync(mkdtempSync(join(tmpdir(), 'rpc-dispatcher-cc-test-')));
      ccFs = new SafeFilesystem({ roots: [ccRoot] });
      ccManager = new ProcessManager({
        roots: [ccRoot],
        policy: allowNodeDashE(),
        limits: { maxCommandConcurrency: 1 },
      });
      ccResponder = new RecordingResponder();
      ccDispatcher = new RpcDispatcher({
        filesystem: ccFs,
        processManager: ccManager,
        responder: ccResponder,
        maxInFlight: 1,
      });
    });

    afterEach(async () => {
      ccManager.killAll(true);
      await waitFor(() => ccManager.list().every((item) => item.status === 'exited'), 'cc test child cleanup did not finish');
      rmSync(ccRoot, { recursive: true, force: true, maxRetries: 3 });
    });

    test('duplicate live id emits nothing, distinct id -> E_CONCURRENCY_LIMIT, cancelled queued start never spawns', async () => {
      // Occupy the ProcessManager's single command-concurrency slot with a holding child.
      const holder = await ccManager.start({ executable: NODE, argv: ['-e', 'setInterval(() => {}, 1000);'] });
      const idsBeforeRelease = new Set(ccManager.list().map((p) => p.id));

      // This proc.start occupies the dispatcher's single in-flight slot while it awaits
      // the ProcessManager semaphore held by the holder above.
      const pendingId = `req-${++requestId}`;
      ccDispatcher.handleFrame(
        makeRpcRequest(pendingId, 'proc.start', { executable: NODE, argv: ['-e', 'process.exit(0)'] }),
      );
      await flush();
      assert.strictEqual(ccResponder.results.has(pendingId), false);
      assert.strictEqual(ccResponder.errors.has(pendingId), false);

      // A duplicate against a still-live requestId must not emit any frame at all, and
      // must not disturb the original pending request (it is not cancelled or settled).
      ccDispatcher.handleFrame(
        makeRpcRequest(pendingId, 'proc.start', { executable: NODE, argv: ['-e', 'process.exit(0)'] }),
      );
      await flush();
      assert.strictEqual(ccResponder.results.has(pendingId), false, 'duplicate must not produce a result frame');
      assert.strictEqual(ccResponder.errors.has(pendingId), false, 'duplicate must not produce an error frame');

      // A distinct requestId while the dispatcher is already at maxInFlight=1 -> E_CONCURRENCY_LIMIT.
      const distinctId = `req-${++requestId}`;
      ccDispatcher.handleFrame(
        makeRpcRequest(distinctId, 'proc.start', { executable: NODE, argv: ['-e', 'process.exit(0)'] }),
      );
      await flush();
      assert.ok(ccResponder.errors.has(distinctId));
      assert.strictEqual(ccResponder.errors.get(distinctId)!.code, E_CONCURRENCY_LIMIT);

      // Cancel the still-pending original request.
      ccDispatcher.handleFrame(makeCancelRequest(pendingId));
      await flush();

      // Release the holder. The cancelled queued start must observe its abort
      // signal after acquiring the semaphore and before spawn, so no orphan child
      // may appear.
      assert.ok(ccManager.kill(holder.id, true));
      await waitFor(
        () => ccManager.list().find((p) => p.id === holder.id)?.status === 'exited',
        'holder did not exit',
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(
        ccManager.list().filter((p) => !idsBeforeRelease.has(p.id)),
        [],
        'cancelled queued start must not spawn a child',
      );

      // The cancelled request itself never receives any response at all, at any point.
      assert.strictEqual(ccResponder.results.has(pendingId), false);
      assert.strictEqual(ccResponder.errors.has(pendingId), false);

      // Explicit cleanup beyond the afterEach hook.
      ccManager.killAll(true);
      await waitFor(() => ccManager.list().every((item) => item.status === 'exited'), 'explicit cleanup did not finish');
    });
  });
});
