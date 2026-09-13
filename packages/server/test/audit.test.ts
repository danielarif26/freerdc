import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HashChainAuditLog, type AuditAppendInput, type AuditRecord } from "../src/audit.js";

const GENESIS_HASH = "0".repeat(64);
const TEST_SECRET = "audit-test-secret-must-not-leak";

function withTemporaryDirectory(name: string, body: (directory: string) => void): void {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-audit-${name}-`)));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function input(action = "filesystem.write"): AuditAppendInput {
  return {
    timestamp: "2026-09-10T12:00:00.000Z",
    action,
    outcome: "succeeded",
    dryRun: false,
    resource: "/workspace/report.txt",
  };
}

function parseRecords(file: string): AuditRecord[] {
  const content = readFileSync(file, "utf8");
  assert.ok(content.endsWith("\n"));
  return content.slice(0, -1).split("\n").map((line) => JSON.parse(line) as AuditRecord);
}

function assertFailsClosed(file: string): void {
  assert.throws(() => new HashChainAuditLog(file), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, new RegExp(TEST_SECRET));
    return true;
  });
}

test("appends linked JSONL records, keeps an owner-only file, and safely closes", () => {
  withTemporaryDirectory("append", (directory) => {
    const file = join(directory, "audit.jsonl");
    const log = new HashChainAuditLog(file);
    const first = log.append(input());
    const second = log.append({ ...input("process.start"), timestamp: "2026-09-10T12:00:01.000Z", outcome: "started", dryRun: true });

    assert.equal(first.seq, 1);
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.match(first.hash, /^[a-f0-9]{64}$/);
    assert.equal(second.seq, 2);
    assert.equal(second.prevHash, first.hash);
    assert.match(second.hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(parseRecords(file), [first, second]);
    if (process.platform !== "win32") assert.equal(lstatSync(file).mode & 0o777, 0o600);

    log.close();
    log.close();
    assert.throws(() => log.append(input()), /closed/);
    assert.throws(() => log.tail(), /closed/);
  });
});

test("reopens verified logs, continues the chain, and returns bounded frozen tails", () => {
  withTemporaryDirectory("reopen", (directory) => {
    const file = join(directory, "audit.jsonl");
    const firstLog = new HashChainAuditLog(file, { maxTailRecords: 2 });
    const first = firstLog.append(input("one"));
    firstLog.append({ ...input("two"), timestamp: "2026-09-10T12:00:01.000Z" });
    firstLog.close();

    const reopened = new HashChainAuditLog(file, { maxTailRecords: 2 });
    const third = reopened.append({ ...input("three"), timestamp: "2026-09-10T12:00:02.000Z" });
    assert.equal(third.seq, 3);
    assert.equal(third.prevHash, parseRecords(file)[1]?.hash);
    const tail = reopened.tail(99);
    assert.equal(tail.length, 2);
    assert.deepEqual(tail.map((record) => record.action), ["two", "three"]);
    assert.ok(Object.isFrozen(tail));
    assert.ok(Object.isFrozen(tail[0]));
    assert.throws(() => { (tail as AuditRecord[]).push(first); }, TypeError);
    reopened.close();
  });
});

test("rejects unsafe audit paths", () => {
  assert.throws(() => new HashChainAuditLog("relative-audit.jsonl"), /absolute/);
  withTemporaryDirectory("paths", (directory) => {
    assert.throws(() => new HashChainAuditLog(join(directory, "missing", "audit.jsonl")), /parent directory/);

    const realParent = join(directory, "real-parent");
    const linkedParent = join(directory, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    assert.throws(() => new HashChainAuditLog(join(linkedParent, "audit.jsonl")), /non-symlink/);

    const target = join(directory, "target.jsonl");
    writeFileSync(target, "");
    const linkedTarget = join(directory, "linked-target.jsonl");
    symlinkSync(target, linkedTarget);
    assert.throws(() => new HashChainAuditLog(linkedTarget), /non-symlink/);

    const directoryTarget = join(directory, "directory-target");
    mkdirSync(directoryTarget);
    assert.throws(() => new HashChainAuditLog(directoryTarget), /regular non-symlink/);
  });
});

test("fails closed when any persisted chain invariant is tampered", () => {
  const mutations: Array<[string, (record: Record<string, unknown>) => void]> = [
    ["action", (record) => { record.action = "tampered"; }],
    ["hash", (record) => { record.hash = "f".repeat(64); }],
    ["sequence", (record) => { record.seq = 99; }],
    ["previous hash", (record) => { record.prevHash = "f".repeat(64); }],
    ["unknown field", (record) => { record.unexpected = true; }],
  ];
  for (const [name, mutate] of mutations) {
    withTemporaryDirectory(`tamper-${name}`, (directory) => {
      const file = join(directory, "audit.jsonl");
      const log = new HashChainAuditLog(file);
      log.append(input());
      log.close();
      const record = parseRecords(file)[0] as unknown as Record<string, unknown>;
      mutate(record);
      writeFileSync(file, `${JSON.stringify(record)}\n`);
      assertFailsClosed(file);
    });
  }
  withTemporaryDirectory("invalid-json", (directory) => {
    const file = join(directory, "audit.jsonl");
    writeFileSync(file, "{not json}\n");
    assertFailsClosed(file);
  });
  withTemporaryDirectory("incomplete", (directory) => {
    const file = join(directory, "audit.jsonl");
    writeFileSync(file, JSON.stringify({ action: TEST_SECRET }));
    assertFailsClosed(file);
  });
});

test("rejects unsafe runtime input without persisting sensitive values", () => {
  withTemporaryDirectory("runtime-input", (directory) => {
    const file = join(directory, "audit.jsonl");
    const log = new HashChainAuditLog(file);
    for (const forbiddenKey of ["argv", "message", "environment", "content", "token", "secret"]) {
      const unsafe = { ...input(), [forbiddenKey]: TEST_SECRET } as AuditAppendInput;
      assert.throws(() => log.append(unsafe), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(TEST_SECRET));
        return true;
      });
    }
    assert.throws(() => log.append({ ...input(), outcome: "unsupported" as AuditAppendInput["outcome"] }), /invalid required fields/);
    assert.throws(() => log.append({ ...input(), timestamp: "2026-09-10" }), /ISO timestamp/);
    assert.equal(readFileSync(file, "utf8"), "");
    assert.doesNotMatch(readFileSync(file, "utf8"), new RegExp(TEST_SECRET));
    log.close();
  });
});

test("tightens permissive permissions on a valid existing audit file where supported", () => {
  if (process.platform === "win32") return;
  withTemporaryDirectory("permissions", (directory) => {
    const file = join(directory, "audit.jsonl");
    const initial = new HashChainAuditLog(file);
    initial.append(input());
    initial.close();
    chmodSync(file, 0o644);
    const reopened = new HashChainAuditLog(file);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    reopened.close();
  });
});


test("tail(0) returns an empty frozen result", () => {
  withTemporaryDirectory("tail-zero", (directory) => {
    const log = new HashChainAuditLog(join(directory, "audit.jsonl"));
    log.append(input("one")); log.append(input("two"));
    const tail = log.tail(0);
    assert.deepEqual(tail, []);
    assert.ok(Object.isFrozen(tail));
    log.close();
  });
});

test("interrupted appends are truncated back to the prior record boundary", () => {
  withTemporaryDirectory("partial-append", (directory) => {
    const file = join(directory, "audit.jsonl");
    let calls = 0;
    const log = new HashChainAuditLog(file, {
      writeRecord(fd, buffer, offset, length) {
        calls += 1;
        if (calls === 1) return writeSync(fd, buffer, offset, Math.min(length, 8));
        if (calls === 2) throw new Error("simulated EIO");
        return writeSync(fd, buffer, offset, length);
      },
    });

    assert.throws(() => log.append(input()), /simulated EIO/);
    assert.equal(readFileSync(file, "utf8"), "");
    assert.deepEqual(log.tail(), []);

    const recovered = log.append(input());
    assert.equal(recovered.seq, 1);
    assert.equal(recovered.prevHash, GENESIS_HASH);
    log.close();
    const reopened = new HashChainAuditLog(file);
    assert.equal(reopened.tail()[0]?.seq, 1);
    reopened.close();
  });
});
