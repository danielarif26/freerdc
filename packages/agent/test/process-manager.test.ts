import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { E_CMD_DENIED, E_CONCURRENCY_LIMIT, E_INTERNAL, E_KILLSWITCH, E_TOO_LARGE, FreeRdcError } from '@freerdc/protocol';

import {
  InMemoryStateProvider,
  POLICY_DENY_REASONS,
  ProcessManager,
  type CommandPlan,
  type CommandPolicy,
  type CommandRule,
} from '../src/index.js';

const NODE = realpathSync(process.execPath);
const NODE_BASENAME = basename(NODE);

function temporaryDirectory(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'freerdc-process-manager-')));
}

function allowNode(argv: CommandRule['argv'] = () => true): CommandPolicy {
  return { rules: [{ executable: NODE, basename: NODE_BASENAME, argv }] };
}

function nodePlan(script: string, overrides: Partial<CommandPlan> = {}): CommandPlan {
  return { executable: NODE, argv: ['-e', script], ...overrides };
}

function errorCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof FreeRdcError);
    assert.equal(error.code, code);
    return true;
  });
}

async function rejectedCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof FreeRdcError);
    assert.equal(error.code, code);
    return true;
  });
}

async function waitFor(check: () => boolean, message: string, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForExit(manager: ProcessManager, id: string): Promise<void> {
  await waitFor(() => manager.list().some((item) => item.id === id && item.status === 'exited'), `process ${id} did not exit`);
}

async function withManager(
  options: Omit<ConstructorParameters<typeof ProcessManager>[0], 'roots'>,
  body: (manager: ProcessManager, root: string) => Promise<void>,
): Promise<void> {
  const root = temporaryDirectory();
  const manager = new ProcessManager({ ...options, roots: [root] });
  try {
    await body(manager, root);
  } finally {
    manager.killAll(true);
    await waitFor(() => manager.list().every((item) => item.status === 'exited'), 'child cleanup did not finish');
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('default and policy denial expose E_CMD_DENIED with only a safe policy reason', async () => {
  await withManager({ policy: { rules: [] } }, async (manager) => {
    await assert.rejects(manager.start(nodePlan('process.exit(0)')), (error: unknown) => {
      assert.ok(error instanceof FreeRdcError);
      assert.equal(error.code, E_CMD_DENIED);
      assert.deepEqual(Object.keys(error.details ?? {}), ['reason']);
      assert.ok(POLICY_DENY_REASONS.includes(error.details?.reason as never));
      return true;
    });
  });

  await withManager({ policy: allowNode(() => false) }, async (manager) => {
    await rejectedCode(manager.start(nodePlan('process.exit(0)')), E_CMD_DENIED);
  });
});

test('an allowed argv-only Node child uses the allowed cwd and a scrubbed environment', async () => {
  await withManager({
    policy: allowNode((argv) => argv[0] === '-e'),
    baseEnv: {
      ORDINARY_DUMMY: 'kept', DUMMY_TOKEN: 'nope', DUMMY_SECRET: 'nope', DUMMY_COOKIE: 'nope',
    },
  }, async (manager, root) => {
    const child = await manager.start(nodePlan("process.stdout.write([process.cwd(), process.env.ORDINARY_DUMMY, String(process.env.DUMMY_TOKEN), String(process.env.DUMMY_SECRET), String(process.env.DUMMY_COOKIE)].join('|'))"));
    await waitForExit(manager, child.id);
    assert.equal(manager.read(child.id)?.stdout.toString(), `${root}|kept|undefined|undefined|undefined`);
  });
});

test('input writes to owned children and enforces maxWriteBytes as E_TOO_LARGE', async () => {
  await withManager({ policy: allowNode(), limits: { maxWriteBytes: 3 } }, async (manager) => {
    const child = await manager.start(nodePlan("process.stdin.once('data', data => process.stdout.write(data));"));
    assert.equal(manager.input(child.id, 'ok'), true);
    errorCode(() => manager.input(child.id, 'four'), E_TOO_LARGE);
    await waitForExit(manager, child.id);
    assert.equal(manager.read(child.id)?.stdout.toString(), 'ok');
  });
});

test('output cap retains at most the configured bytes, truncates, and terminates its child', async () => {
  await withManager({ policy: allowNode(), limits: { maxOutputBytes: 16 } }, async (manager) => {
    const child = await manager.start(nodePlan("process.stdout.write('x'.repeat(512)); setInterval(() => {}, 1000);"));
    await waitForExit(manager, child.id);
    const result = manager.read(child.id);
    assert.ok(result);
    assert.ok(result.stdout.byteLength + result.stderr.byteLength <= 16);
    assert.equal(result.truncated, true);
    assert.equal(result.status, 'exited');
  });
});

test('timeout force-terminates a SIGTERM-ignoring child and releases command concurrency', async () => {
  await withManager({ policy: allowNode(), limits: { commandTimeoutMs: 5000, maxCommandConcurrency: 1 } }, async (manager) => {
    const stubborn = await manager.start(nodePlan("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", { timeoutMs: 40 }));
    const queued = manager.start(nodePlan("process.stdout.write('released')"));
    await waitForExit(manager, stubborn.id);
    const next = await queued;
    await waitForExit(manager, next.id);
    assert.equal(manager.read(next.id)?.stdout.toString(), 'released');
  });
});

test('maxCommandConcurrency queues one start and releases it exactly once', async () => {
  await withManager({ policy: allowNode(), limits: { maxCommandConcurrency: 1 } }, async (manager) => {
    const first = await manager.start(nodePlan("setTimeout(() => process.exit(0), 80);"));
    const secondStart = manager.start(nodePlan("process.stdout.write('second')"));
    assert.equal(manager.list().length, 1);
    await waitForExit(manager, first.id);
    const second = await secondStart;
    await waitForExit(manager, second.id);
    assert.equal(manager.read(second.id)?.stdout.toString(), 'second');
    assert.equal(manager.list().length, 1);
  });
});

test('only opaque manager-owned IDs can be killed and summaries never expose argv or environment', async () => {
  await withManager({ policy: allowNode(), baseEnv: { SECRET_VALUE: 'not-visible' } }, async (manager) => {
    const child = await manager.start(nodePlan("setTimeout(() => {}, 500);", { argv: ['-e', "setTimeout(() => {}, 500)", 'private-argv'] }));
    assert.equal(manager.kill(String(process.pid)), false);
    assert.equal(manager.kill('not-a-manager-id'), false);
    const [summary] = manager.list();
    assert.ok(summary);
    assert.deepEqual(Object.keys(summary).sort(), ['id', 'startedAt', 'status']);
    assert.doesNotMatch(JSON.stringify(summary), /private-argv|SECRET_VALUE|not-visible/);
    assert.equal(manager.kill(child.id, true), true);
    await waitForExit(manager, child.id);
    assert.ok(manager.read(child.id));
    assert.equal(manager.read(child.id), undefined);
  });
});

test('the kill switch blocks start and input, including activation after a child starts', async () => {
  const state = new InMemoryStateProvider();
  await withManager({ policy: allowNode(), stateProvider: state }, async (manager) => {
    const child = await manager.start(nodePlan("setInterval(() => {}, 1000);"));
    state.setActive(true);
    await rejectedCode(manager.start(nodePlan('process.exit(0)')), E_KILLSWITCH);
    errorCode(() => manager.input(child.id, 'no'), E_KILLSWITCH);
  });
});

test('dryRun plan is side-effect-free and returns a planned result', async () => {
  await withManager({ policy: allowNode() }, async (manager, root) => {
    const marker = join(root, 'must-not-exist');
    const result = await manager.start(nodePlan(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`, { dryRun: 'plan' })) as unknown as { planned?: boolean };
    assert.equal(result.planned, true);
    assert.equal(manager.list().length, 0);
    assert.throws(() => realpathSync(marker));
  });
});

test('invalid dry-run and timeout values are denied', async () => {
  await withManager({ policy: allowNode() }, async (manager) => {
    await rejectedCode(manager.start(nodePlan('process.exit(0)', { dryRun: 'invalid' as never })), E_CMD_DENIED);
    await rejectedCode(manager.start(nodePlan('process.exit(0)', { timeoutMs: 0 })), E_CMD_DENIED);
    await rejectedCode(manager.start(nodePlan('process.exit(0)', { timeoutMs: 1.5 })), E_CMD_DENIED);
  });
});

test('outside, denied, and non-directory working directories are rejected', async () => {
  await withManager({ policy: allowNode() }, async (manager, root) => {
    const outside = temporaryDirectory();
    const file = join(root, 'file');
    writeFileSync(file, 'not a directory');
    try {
      await assert.rejects(manager.start(nodePlan('process.exit(0)', { cwd: outside })));
      await assert.rejects(manager.start(nodePlan('process.exit(0)', { cwd: join(homedir(), '.ssh') })));
      await assert.rejects(manager.start(nodePlan('process.exit(0)', { cwd: file })));
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

test('a policy approval for Node realpath permits its symlink alias without leaking the alias', async () => {
  await withManager({ policy: allowNode() }, async (manager, root) => {
    const alias = join(root, 'node-alias');
    symlinkSync(NODE, alias, 'file');
    const child = await manager.start({ executable: alias, argv: ['-e', 'process.stdout.write(process.execPath)'] });
    await waitForExit(manager, child.id);
    assert.equal(manager.read(child.id)?.stdout.toString(), NODE);
  });
});


test("stdin backpressure accepts the first write exactly once and blocks further buffering", async () => {
  await withManager({ policy: allowNode(), limits: { maxWriteBytes: 1_048_576 } }, async (manager) => {
    const child = await manager.start(nodePlan("setTimeout(() => process.exit(0), 500);"));
    assert.equal(manager.input(child.id, Buffer.alloc(1_048_576, 1)), true);
    errorCode(() => manager.input(child.id, "duplicate"), E_CONCURRENCY_LIMIT);
    manager.kill(child.id, true);
    await waitForExit(manager, child.id);
    assert.ok(manager.read(child.id));
    assert.equal(manager.input(child.id, "after-close"), false);
  });
});

test("bounded reads retain unread process output for subsequent calls", async () => {
  await withManager({ policy: allowNode(), limits: { maxOutputBytes: 1024 } }, async (manager) => {
    const child = await manager.start(nodePlan("process.stdout.write('x'.repeat(100));"));
    await waitForExit(manager, child.id);
    const chunks: Buffer[] = [];
    for (;;) {
      const part = manager.read(child.id, 16);
      assert.ok(part);
      assert.ok(part.stdout.byteLength + part.stderr.byteLength <= 16);
      chunks.push(part.stdout, part.stderr);
      if (!part.hasMore) break;
    }
    assert.equal(Buffer.concat(chunks).toString(), "x".repeat(100));
    assert.equal(manager.read(child.id, 16), undefined);
  });
});

test("maxSessions evicts the oldest exited unread session under capacity pressure", async () => {
  await withManager({ policy: allowNode(), maxSessions: 1 }, async (manager) => {
    const first = await manager.start(nodePlan("process.stdout.write('one')"));
    await waitForExit(manager, first.id);
    const second = await manager.start(nodePlan("process.stdout.write('two')"));
    assert.equal(manager.read(first.id), undefined);
    await waitForExit(manager, second.id);
    assert.equal(manager.read(second.id)?.stdout.toString(), "two");
  });
});

test("truncation is sticky while hasMore only describes unread buffered bytes", async () => {
  await withManager({ policy: allowNode(), limits: { maxOutputBytes: 16 } }, async (manager) => {
    const child = await manager.start(nodePlan("process.stdout.write('x'.repeat(512)); setInterval(() => {}, 1000);"));
    await waitForExit(manager, child.id);
    const final = manager.read(child.id, 16);
    assert.ok(final);
    assert.equal(final.truncated, true);
    assert.equal(final.hasMore, false);
    assert.equal(manager.read(child.id), undefined);
  });
});

test("bounded reads reserve nonzero stderr budget when both streams are buffered", async () => {
  await withManager({ policy: allowNode(), limits: { maxOutputBytes: 1024 } }, async (manager) => {
    const child = await manager.start(nodePlan("process.stdout.write('o'.repeat(100)); process.stderr.write('e'.repeat(100));"));
    await waitForExit(manager, child.id);
    const first = manager.read(child.id, 16);
    assert.ok(first);
    assert.equal(first.stdout.byteLength, 8);
    assert.equal(first.stderr.byteLength, 8);
    const single = manager.peek(child.id, 1);
    assert.ok(single);
    assert.equal(single.stdout.byteLength, 0);
    assert.equal(single.stderr.byteLength, 1);
  });
});

test("aborting after spawn but before start acknowledgement terminates and removes the session", async () => {
  await withManager({ policy: allowNode(), maxSessions: 1 }, async (manager) => {
    const controller = new AbortController();
    const pending = manager.start(nodePlan("setInterval(() => {}, 1000);"), { signal: controller.signal });
    // The semaphore continuation has spawned but is awaiting Node's async
    // spawn acknowledgement when this queued cancellation runs.
    queueMicrotask(() => controller.abort());
    await rejectedCode(pending, E_CMD_DENIED);
    await waitFor(() => manager.list().length === 0, "cancelled session was not removed");
    const replacement = await manager.start(nodePlan("process.stdout.write('replacement')"));
    await waitForExit(manager, replacement.id);
    assert.equal(manager.read(replacement.id)?.stdout.toString(), "replacement");
  });
});

test("aborting a request signal after a successful start does not kill its owned session", async () => {
  await withManager({ policy: allowNode() }, async (manager) => {
    const controller = new AbortController();
    const child = await manager.start(nodePlan("setInterval(() => {}, 1000);"), { signal: controller.signal });
    controller.abort();
    assert.equal(manager.list().find((item) => item.id === child.id)?.status, "running");
    assert.equal(manager.kill(child.id, true), true);
    await waitForExit(manager, child.id);
  });
});

test("pending starts reserve capacity and release it and their semaphore permit exactly once on abort", async () => {
  await withManager({ policy: allowNode(), maxSessions: 2, limits: { maxCommandConcurrency: 1 } }, async (manager) => {
    const holder = await manager.start(nodePlan("setInterval(() => {}, 1000);"));
    const controller = new AbortController();
    const pending = manager.start(nodePlan("process.stdout.write('must-not-run')"), { signal: controller.signal });
    await waitFor(() => manager.list().length === 1, "queued start unexpectedly spawned");
    await rejectedCode(manager.start(nodePlan("process.stdout.write('over-cap')")), E_CONCURRENCY_LIMIT);
    controller.abort();
    assert.equal(manager.kill(holder.id, true), true);
    await rejectedCode(pending, E_CMD_DENIED);
    const replacement = await manager.start(nodePlan("process.stdout.write('released')"));
    await waitForExit(manager, replacement.id);
    assert.equal(manager.read(replacement.id)?.stdout.toString(), "released");
  });
});

test("async spawn failure removes its session and releases concurrency", async () => {
  await withManager({ policy: allowNode(), limits: { maxCommandConcurrency: 1 } }, async (manager, root) => {
    const notExecutable = join(root, "not-executable");
    writeFileSync(notExecutable, "not executable");
    chmodSync(notExecutable, 0o600);
    const policy: CommandPolicy = { rules: [{ executable: notExecutable, basename: "not-executable", argv: () => true }, ...allowNode().rules] };
    const failing = new ProcessManager({ roots: [root], policy, limits: { maxCommandConcurrency: 1 } });
    await rejectedCode(failing.start({ executable: notExecutable, argv: [] }), E_INTERNAL);
    assert.equal(failing.list().length, 0);
    const replacement = await failing.start(nodePlan("process.stdout.write('ok')"));
    await waitForExit(failing, replacement.id);
    assert.equal(failing.read(replacement.id)?.stdout.toString(), "ok");
  });
});
