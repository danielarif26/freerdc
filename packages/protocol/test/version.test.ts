import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  negotiate,
  WIRE_ID,
  WIRE_VERSION,
  CAPABILITY_FS_V1,
  CAPABILITY_SEARCH_V1,
  CAPABILITY_PTY_V1,
  CAPABILITY_PTY_PIPE_V1,
  CAPABILITY_PROC_V1,
  CAPABILITY_TRASH_V1,
  CAPABILITY_DRYRUN_V1,
  ALL_CAPABILITIES
} from "../src/version.js";

test("exports: WIRE_ID and WIRE_VERSION", () => {
  assert.strictEqual(WIRE_ID, "freerdc-wire");
  assert.deepStrictEqual(WIRE_VERSION, { major: 1, minor: 0 });
});

test("exports: capability constants", () => {
  assert.strictEqual(CAPABILITY_FS_V1, "fs.v1");
  assert.strictEqual(CAPABILITY_SEARCH_V1, "search.v1");
  assert.strictEqual(CAPABILITY_PTY_V1, "pty.v1");
  assert.strictEqual(CAPABILITY_PTY_PIPE_V1, "pty.pipe.v1");
  assert.strictEqual(CAPABILITY_PROC_V1, "proc.v1");
  assert.strictEqual(CAPABILITY_TRASH_V1, "trash.v1");
  assert.strictEqual(CAPABILITY_DRYRUN_V1, "dryrun.v1");
});

test("exports: ALL_CAPABILITIES readonly array", () => {
  assert.deepStrictEqual(ALL_CAPABILITIES, [
    "fs.v1",
    "search.v1",
    "pty.v1",
    "pty.pipe.v1",
    "proc.v1",
    "trash.v1",
    "dryrun.v1"
  ]);
  assert.ok(Array.isArray(ALL_CAPABILITIES));
});

test("negotiate: major match, minor accept both directions", () => {
  // Local minor smaller
  let result = negotiate(
    { version: { major: 1, minor: 0 }, supported: [] },
    { version: { major: 1, minor: 5 }, supported: [] }
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.strictEqual(result.version.major, 1);
    assert.strictEqual(result.version.minor, 0);
  }

  // Remote minor smaller
  result = negotiate(
    { version: { major: 1, minor: 5 }, supported: [] },
    { version: { major: 1, minor: 0 }, supported: [] }
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.strictEqual(result.version.major, 1);
    assert.strictEqual(result.version.minor, 0);
  }
});

test("negotiate: major mismatch rejects", () => {
  const result = negotiate(
    { version: WIRE_VERSION, supported: [] },
    { version: { major: 2, minor: 0 }, supported: [] }
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.error, "E_PROTOCOL_VERSION");
    assert.deepStrictEqual(result.details, {
      local: WIRE_VERSION,
      remote: { major: 2, minor: 0 }
    });
  }
});

test("negotiate: capabilities intersection preserves local order", () => {
  const result = negotiate(
    {
      version: WIRE_VERSION,
      supported: ["search.v1", "fs.v1", "pty.v1", "fs.v1"] // fs.v1 duplicated
    },
    { version: WIRE_VERSION, supported: ["pty.v1", "fs.v1", "search.v1", "unknown"] }
  );
  assert.ok(result.ok);
  if (result.ok) {
    // Intersection: search.v1 (local idx 0), fs.v1 (local idx 1), pty.v1 (local idx 2)
    // fs.v1 duplicated in local should appear only once (Set-like behavior from filter)
    assert.deepStrictEqual(result.capabilities, ["search.v1", "fs.v1", "pty.v1"]);
  }
});

test("negotiate: required missing deduplicated and in local required order", () => {
  const result = negotiate(
    {
      version: WIRE_VERSION,
      supported: ["fs.v1"],
      required: ["pty.v1", "search.v1", "pty.v1"] // pty.v1 duplicated
    },
    { version: WIRE_VERSION, supported: ["fs.v1"] } // missing pty.v1, search.v1
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.error, "E_CAPABILITY_UNSUPPORTED");
    // Should deduplicate and preserve local required order: pty.v1 first, then search.v1
    assert.deepStrictEqual(result.details, { missing: ["pty.v1", "search.v1"] });
  }
});

test("negotiate: required present passes", () => {
  const result = negotiate(
    {
      version: WIRE_VERSION,
      supported: ["fs.v1", "pty.v1", "search.v1"],
      required: ["search.v1", "pty.v1"]
    },
    { version: WIRE_VERSION, supported: ["pty.v1", "search.v1", "fs.v1"] }
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.strictEqual(result.version.major, 1);
    assert.strictEqual(result.version.minor, 0);
    // Intersection in local supported order: fs.v1, pty.v1, search.v1
    assert.deepStrictEqual(result.capabilities, ["fs.v1", "pty.v1", "search.v1"]);
  }
});

test("negotiate: remote-only capabilities ignored", () => {
  const result = negotiate(
    { version: WIRE_VERSION, supported: ["fs.v1"] },
    { version: WIRE_VERSION, supported: ["fs.v1", "remote-only.v1", "another-remote"] }
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepStrictEqual(result.capabilities, ["fs.v1"]); // remote-only ignored
  }
});

test("negotiate: empty intersection", () => {
  const result = negotiate(
    { version: WIRE_VERSION, supported: ["fs.v1"] },
    { version: WIRE_VERSION, supported: ["pty.v1"] }
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepStrictEqual(result.capabilities, []);
  }
});
