import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RPC_METHODS,
  RPC_PARAM_SCHEMAS,
  WireBytes,
  isCanonicalBase64,
  isCanonicalUtf8,
  isRpcMethod,
  parseRpcParams,
  type RpcMethod,
} from "../src/rpc.js";
import { FreeRdcError, E_MALFORMED_MESSAGE } from "../src/errors.js";

const HASH = "a".repeat(64);

const METHODS: readonly RpcMethod[] = [
  "fs.stat",
  "fs.list",
  "fs.read",
  "fs.search",
  "fs.mkdir",
  "fs.write",
  "fs.delete",
  "fs.move",
  "proc.start",
  "proc.read",
  "proc.input",
  "proc.kill",
  "proc.list",
];

const VALID: Record<RpcMethod, unknown> = {
  "fs.stat": { path: "/tmp" },
  "fs.list": { path: "/tmp" },
  "fs.read": { path: "/tmp" },
  "fs.search": { path: "/tmp", query: "needle" },
  "fs.mkdir": { path: "/tmp/dir" },
  "fs.write": { path: "/tmp/file", content: { encoding: "utf8", data: "hello" } },
  "fs.delete": { path: "/tmp/file", expectedSha256: HASH },
  "fs.move": { source: "/tmp/a", destination: "/tmp/b", expectedSha256: HASH },
  "proc.start": { executable: "/bin/echo" },
  "proc.read": { id: "proc-1" },
  "proc.input": { id: "proc-1", data: { encoding: "utf8", data: "stdin" } },
  "proc.kill": { id: "proc-1" },
  "proc.list": {},
};

test("RPC_METHODS is the exact 13-method readonly tuple", () => {
  assert.deepEqual(RPC_METHODS, METHODS);
  assert.equal(RPC_METHODS.length, 13);
});

test("isRpcMethod accepts only the canonical method names", () => {
  for (const method of RPC_METHODS) {
    assert.equal(isRpcMethod(method), true);
  }
  for (const value of ["fs.stat ", "FS.stat", "fs", "proc", "unknown", "", 1, null, undefined, {}, []]) {
    assert.equal(isRpcMethod(value), false);
  }
});

test("parseRpcParams accepts representative valid params for every method", () => {
  for (const method of RPC_METHODS) {
    assert.ok(RPC_PARAM_SCHEMAS[method]);
    const parsed = parseRpcParams(method, VALID[method]);
    assert.equal(typeof parsed, "object");
    assert.notEqual(parsed, null);
  }
});

test("parseRpcParams applies documented defaults", () => {
  assert.deepEqual(parseRpcParams("fs.mkdir", { path: "/tmp/dir" }), {
    path: "/tmp/dir",
    dryRun: "off",
  });
  assert.deepEqual(
    parseRpcParams("fs.write", {
      path: "/tmp/file",
      content: { encoding: "utf8", data: "hello" },
    }),
    {
      path: "/tmp/file",
      content: { encoding: "utf8", data: "hello" },
      dryRun: "off",
    },
  );
  assert.deepEqual(
    parseRpcParams("fs.delete", { path: "/tmp/file", expectedSha256: HASH }),
    { path: "/tmp/file", expectedSha256: HASH, dryRun: "off" },
  );
  assert.deepEqual(
    parseRpcParams("fs.move", {
      source: "/tmp/a",
      destination: "/tmp/b",
      expectedSha256: HASH,
    }),
    {
      source: "/tmp/a",
      destination: "/tmp/b",
      expectedSha256: HASH,
      dryRun: "off",
    },
  );
  assert.deepEqual(parseRpcParams("proc.start", { executable: "/bin/echo" }), {
    executable: "/bin/echo",
    argv: [],
    dryRun: "off",
  });
  assert.deepEqual(parseRpcParams("proc.kill", { id: "proc-1" }), {
    id: "proc-1",
    force: false,
  });
  assert.deepEqual(parseRpcParams("proc.list", {}), {});
});

test("parseRpcParams accepts optional fields and explicit dryRun/force", () => {
  assert.deepEqual(
    parseRpcParams("fs.search", {
      path: "/tmp",
      query: "needle",
      caseSensitive: true,
      maxDepth: 0,
    }),
    { path: "/tmp", query: "needle", caseSensitive: true, maxDepth: 0 },
  );
  assert.deepEqual(
    parseRpcParams("fs.write", {
      path: "/tmp/file",
      content: { encoding: "base64", data: "aGVsbG8=" },
      expectedSha256: HASH,
      dryRun: "plan",
    }),
    {
      path: "/tmp/file",
      content: { encoding: "base64", data: "aGVsbG8=" },
      expectedSha256: HASH,
      dryRun: "plan",
    },
  );
  assert.deepEqual(
    parseRpcParams("proc.start", {
      executable: "/bin/echo",
      argv: ["hello"],
      cwd: "/tmp",
      timeoutMs: 1,
      dryRun: "plan",
    }),
    {
      executable: "/bin/echo",
      argv: ["hello"],
      cwd: "/tmp",
      timeoutMs: 1,
      dryRun: "plan",
    },
  );
  assert.deepEqual(parseRpcParams("proc.kill", { id: "proc-1", force: true }), {
    id: "proc-1",
    force: true,
  });
  assert.deepEqual(
    parseRpcParams("proc.input", {
      id: "proc-1",
      data: { encoding: "base64", data: "" },
    }),
    { id: "proc-1", data: { encoding: "base64", data: "" } },
  );
});

test("strict schemas reject representative unknown fields", () => {
  assert.throws(() => parseRpcParams("fs.stat", { path: "/tmp", extra: true }), FreeRdcError);
  assert.throws(() => parseRpcParams("proc.list", { extra: 1 }), FreeRdcError);
  assert.throws(
    () => parseRpcParams("fs.write", {
      path: "/tmp/file",
      content: { encoding: "utf8", data: "hello", extra: true },
    }),
    FreeRdcError,
  );
});

test("canonical base64 validator and WireBytes reject unpadded aliases", () => {
  assert.equal(isCanonicalBase64(""), true);
  assert.equal(isCanonicalBase64("YQ=="), true);
  assert.equal(isCanonicalBase64("aGVsbG8="), true);
  assert.equal(isCanonicalBase64("YQ"), false);
  assert.equal(isCanonicalBase64("aGVsbG8"), false);
  assert.equal(isCanonicalBase64("YQ==\n"), false);

  assert.equal(WireBytes.safeParse({ encoding: "utf8", data: "hello" }).success, true);
  assert.equal(WireBytes.safeParse({ encoding: "base64", data: "" }).success, true);
  assert.equal(WireBytes.safeParse({ encoding: "base64", data: "YQ==" }).success, true);
  assert.equal(WireBytes.safeParse({ encoding: "base64", data: "YQ" }).success, false);
  assert.equal(WireBytes.safeParse({ encoding: "utf8", data: "YQ" }).success, true);

  assert.throws(
    () => parseRpcParams("fs.write", {
      path: "/tmp/file",
      content: { encoding: "base64", data: "YQ" },
    }),
    FreeRdcError,
  );
  assert.throws(
    () => parseRpcParams("proc.input", {
      id: "proc-1",
      data: { encoding: "base64", data: "aGVsbG8" },
    }),
    FreeRdcError,
  );
});

test("canonical utf8 validator and WireBytes accept valid UTF-8 and reject lone surrogates", () => {
  // valid UTF-8 round-trips
  assert.equal(isCanonicalUtf8("hello"), true);
  assert.equal(isCanonicalUtf8("Hello, 世界"), true);
  assert.equal(isCanonicalUtf8("H\u0000i"), true);
  assert.equal(isCanonicalUtf8(""), true);
  assert.equal(isCanonicalUtf8("a"), true);

  // lone surrogates and other malformed UTF-16 sequences fail
  assert.equal(isCanonicalUtf8("\uD800"), false); // leading surrogate
  assert.equal(isCanonicalUtf8("\uDFFF"), false); // trailing surrogate
  assert.equal(isCanonicalUtf8("\uD800\uD800"), false); // two leading surrogates

  // WireBytes rejects malformed utf8
  assert.equal(WireBytes.safeParse({ encoding: "utf8", data: "hello" }).success, true);
  assert.equal(WireBytes.safeParse({ encoding: "utf8", data: "\uD800" }).success, false);
  assert.equal(WireBytes.safeParse({ encoding: "utf8", data: "\uDFFF" }).success, false);
  assert.equal(WireBytes.safeParse({ encoding: "utf8", data: "\uD800\uD800" }).success, false);

  // parseRpcParams with ordinary Unicode UTF-8 succeeds (regression test)
  const unicodeContent = "Hello, 世界 🎉";
  const parsed = parseRpcParams("fs.write", {
    path: "/tmp/file",
    content: { encoding: "utf8", data: unicodeContent },
  });
  assert.deepEqual(parsed, {
    path: "/tmp/file",
    content: { encoding: "utf8", data: unicodeContent },
    dryRun: "off",
  });

  // lone surrogate throws sanitized E_MALFORMED_MESSAGE (no details/raw leak)
  const sentinel = "RAW_SENTINEL_DO_NOT_LEAK_xyzz";
  assert.throws(
    () => parseRpcParams("fs.write", {
      path: "/tmp/file",
      content: { encoding: "utf8", data: "\uD800" + sentinel },
    }),
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal(err.code, E_MALFORMED_MESSAGE);
      assert.equal(err.details, undefined);
      assert.equal(err.message, E_MALFORMED_MESSAGE);
      assert.equal(err.message.includes(sentinel), false);
      assert.equal(JSON.stringify(err).includes(sentinel), false);
      return true;
    },
  );
});

test("malformed params throw FreeRdcError E_MALFORMED_MESSAGE without details or sentinel", () => {
  const sentinel = "RAW_SENTINEL_DO_NOT_LEAK_xyzz";
  assert.throws(
    () => parseRpcParams("fs.stat", { path: "", extra: sentinel }),
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal(err.code, E_MALFORMED_MESSAGE);
      assert.equal(err.details, undefined);
      assert.equal(err.message, E_MALFORMED_MESSAGE);
      assert.equal(err.message.includes(sentinel), false);
      assert.equal(JSON.stringify(err).includes(sentinel), false);
      return true;
    },
  );
});

test("proc.start rejects relative executable path (E_MALFORMED_MESSAGE)", () => {
  assert.throws(
    () => parseRpcParams("proc.start", { executable: "bin/echo" }),
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal(err.code, E_MALFORMED_MESSAGE);
      assert.equal(err.details, undefined);
      assert.equal(err.message, E_MALFORMED_MESSAGE);
      return true;
    },
  );
});


test("hash-guarded RPC params require exactly 64 hexadecimal characters", () => {
  for (const method of ["fs.delete", "fs.move"] as const) {
    for (const invalid of ["", "abc123", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const params = method === "fs.delete"
        ? { path: "/tmp/file", expectedSha256: invalid }
        : { source: "/tmp/a", destination: "/tmp/b", expectedSha256: invalid };
      assert.throws(
        () => parseRpcParams(method, params),
        (error: unknown) => error instanceof FreeRdcError && error.code === E_MALFORMED_MESSAGE,
      );
    }
  }
  assert.deepEqual(
    parseRpcParams("fs.write", { path: "/tmp/file", content: { encoding: "utf8", data: "x" }, expectedSha256: HASH.toUpperCase() }),
    { path: "/tmp/file", content: { encoding: "utf8", data: "x" }, expectedSha256: HASH.toUpperCase(), dryRun: "off" },
  );
});
