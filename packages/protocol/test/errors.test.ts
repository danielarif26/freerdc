import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ErrorCode } from "../src/errors.js";
import {
  FreeRdcError,
  ERROR_CODES,
  E_PROTOCOL_VERSION,
  E_CAPABILITY_UNSUPPORTED,
  E_MALFORMED_MESSAGE,
  E_UNAUTHORIZED,
  E_PATH_DENIED,
  E_PATH_ESCAPE,
  E_CMD_DENIED,
  E_RATE_LIMITED,
  E_CONCURRENCY_LIMIT,
  E_DEVICE_OFFLINE,
  E_KILLSWITCH,
  E_TOO_LARGE,
  E_TIMEOUT,
  E_STALE_HASH,
  E_INTERNAL,
  E_UNSUPPORTED_CAPABILITY,
  E_ROOT_ESCAPE,
  E_RATE_LIMIT,
} from "../src/errors.js";

test("errors: all canonical codes in ERROR_CODES", () => {
  const expectedCodes = [
    E_PROTOCOL_VERSION,
    E_CAPABILITY_UNSUPPORTED,
    E_MALFORMED_MESSAGE,
    E_UNAUTHORIZED,
    E_PATH_DENIED,
    E_PATH_ESCAPE,
    E_CMD_DENIED,
    E_RATE_LIMITED,
    E_CONCURRENCY_LIMIT,
    E_DEVICE_OFFLINE,
    E_KILLSWITCH,
    E_TOO_LARGE,
    E_TIMEOUT,
    E_STALE_HASH,
    E_INTERNAL,
  ];
  for (const code of expectedCodes) {
    assert.strictEqual(typeof code, "string");
  }
});

test("errors: Object.values(ERROR_CODES) equals 15 canonical constants exactly", () => {
  const values = Object.values(ERROR_CODES);
  assert.strictEqual(values.length, 15);

  const expected: readonly ErrorCode[] = [
    "E_PROTOCOL_VERSION",
    "E_CAPABILITY_UNSUPPORTED",
    "E_MALFORMED_MESSAGE",
    "E_UNAUTHORIZED",
    "E_PATH_DENIED",
    "E_PATH_ESCAPE",
    "E_CMD_DENIED",
    "E_RATE_LIMITED",
    "E_CONCURRENCY_LIMIT",
    "E_DEVICE_OFFLINE",
    "E_KILLSWITCH",
    "E_TOO_LARGE",
    "E_TIMEOUT",
    "E_STALE_HASH",
    "E_INTERNAL",
  ];

  for (const code of expected) {
    assert.ok(values.includes(code));
  }

  for (const value of values) {
    assert.ok(expected.includes(value));
  }
});

test("errors: aliases are absent from ERROR_CODES", () => {
  const keys = Object.keys(ERROR_CODES);
  assert.strictEqual(keys.length, 15);

  const aliasKeys = ["E_UNSUPPORTED_CAPABILITY", "E_ROOT_ESCAPE", "E_RATE_LIMIT"];
  for (const key of aliasKeys) {
    assert.strictEqual(keys.includes(key), false);
  }
});

test("errors: alias equality tests", () => {
  assert.strictEqual(E_UNSUPPORTED_CAPABILITY, E_CAPABILITY_UNSUPPORTED);
  assert.strictEqual(E_ROOT_ESCAPE, E_PATH_ESCAPE);
  assert.strictEqual(E_RATE_LIMIT, E_RATE_LIMITED);
});

test("errors: constructor form 1 - code only", () => {
  const err = new FreeRdcError(E_MALFORMED_MESSAGE);
  assert.strictEqual(err.code, E_MALFORMED_MESSAGE);
  assert.strictEqual(err.message, E_MALFORMED_MESSAGE);
  assert.strictEqual(err.details, undefined);
  assert.strictEqual(err.name, "FreeRdcError");
});

test("errors: constructor form 2 - code with details object (backwards compatible)", () => {
  const err = new FreeRdcError(E_MALFORMED_MESSAGE, { key: "value" });
  assert.strictEqual(err.code, E_MALFORMED_MESSAGE);
  assert.strictEqual(err.message, E_MALFORMED_MESSAGE);
  assert.deepStrictEqual(err.details, { key: "value" });
});

test("errors: constructor form 3 - code with safe message and details", () => {
  const err = new FreeRdcError(
    E_MALFORMED_MESSAGE,
    "Custom error message",
    { key: "value" }
  );
  assert.strictEqual(err.code, E_MALFORMED_MESSAGE);
  assert.strictEqual(err.message, "Custom error message");
  assert.deepStrictEqual(err.details, { key: "value" });
  assert.strictEqual(err.name, "FreeRdcError");
});

test("errors: ErrorCode type narrowing", () => {
  const codes = Object.values(ERROR_CODES) as ErrorCode[];
  for (const code of codes) {
    const err = new FreeRdcError(code);
    assert.strictEqual(err.code, code);
  }
});

test("errors: FreeRdcError with custom message and details", () => {
  const err = new FreeRdcError(
    E_MALFORMED_MESSAGE,
    "Custom error message",
    { key: "value" }
  );
  assert.strictEqual(err.code, E_MALFORMED_MESSAGE);
  assert.strictEqual(err.message, "Custom error message");
  assert.deepStrictEqual(err.details, { key: "value" });
  assert.strictEqual(err.name, "FreeRdcError");
});

test("errors: FreeRdcError redacts secrets", () => {
  const err = new FreeRdcError(
    E_UNAUTHORIZED,
    "Unauthorized",
    { password: "secret123", token: "abc123", public: "data" }
  );
  const wire = err.toWire();
  assert.strictEqual(wire.code, E_UNAUTHORIZED);
  assert.strictEqual(wire.message, E_UNAUTHORIZED);
  assert.ok(wire.details !== undefined);
  assert.strictEqual((wire.details as Record<string, unknown>).password, "[REDACTED]");
  assert.strictEqual((wire.details as Record<string, unknown>).token, "[REDACTED]");
  assert.strictEqual((wire.details as Record<string, unknown>).public, "data");
});

test("errors: toWire preserves secret key names with [REDACTED] values", () => {
  const err = new FreeRdcError(
    E_PATH_DENIED,
    "Denied",
    { secret_key: "value", public_key: "data" }
  );
  const wire = err.toWire();
  assert.ok(wire.details !== undefined);
  assert.ok("secret_key" in wire.details);
  assert.strictEqual((wire.details as Record<string, unknown>).secret_key, "[REDACTED]");
  assert.strictEqual((wire.details as Record<string, unknown>).public_key, "data");
});

test("errors: toWire omits stack and cause", () => {
  const original = new Error("original");
  const err = new FreeRdcError(E_PROTOCOL_VERSION, "message", { original });
  const wire = err.toWire();
  assert.ok(wire.code !== undefined);
  assert.ok(wire.message !== undefined);
  assert.strictEqual((wire as any).stack, undefined);
  assert.strictEqual((wire as any).cause, undefined);
});

test("errors: toWire with no details", () => {
  const err = new FreeRdcError(E_PROTOCOL_VERSION);
  const wire = err.toWire();
  assert.strictEqual(wire.code, E_PROTOCOL_VERSION);
  assert.strictEqual(wire.message, E_PROTOCOL_VERSION);
  assert.strictEqual(wire.details, undefined);
});

test("errors: aliases equal canonical codes", () => {
  assert.strictEqual(E_UNSUPPORTED_CAPABILITY, E_CAPABILITY_UNSUPPORTED);
  assert.strictEqual(E_ROOT_ESCAPE, E_PATH_ESCAPE);
  assert.strictEqual(E_RATE_LIMIT, E_RATE_LIMITED);
});

test("errors: toWire redacts sensitive VALUES while preserving original keys", () => {
  const err = new FreeRdcError(
    E_UNAUTHORIZED,
    "Test error",
    {
      password: "secret123",
      api_key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      public_field: "public_value",
      token: "Bearer abc123def456",
      secret_token_value: "hex123456789abcdef"
    }
  );
  const wire = err.toWire();
  assert.strictEqual(wire.code, E_UNAUTHORIZED);
  assert.strictEqual(wire.message, E_UNAUTHORIZED);
  assert.ok(wire.details !== undefined);
  assert.strictEqual(wire.details?.public_field, "public_value");
  assert.strictEqual((wire.details as Record<string, unknown>).password, "[REDACTED]");
  assert.strictEqual((wire.details as Record<string, unknown>).api_key, "[REDACTED]");
  assert.strictEqual((wire.details as Record<string, unknown>).token, "[REDACTED]");
  assert.strictEqual((wire.details as Record<string, unknown>).secret_token_value, "[REDACTED]");
  assert.strictEqual(Object.keys(wire.details!).length, 5);
});

test("errors: toWire with safe message only", () => {
  const err = new FreeRdcError(E_PROTOCOL_VERSION, "safe message");
  const wire = err.toWire();
  assert.strictEqual(wire.code, E_PROTOCOL_VERSION);
  assert.strictEqual(wire.message, E_PROTOCOL_VERSION);
  assert.strictEqual(wire.details, undefined);
});


test("errors: custom messages never cross the wire boundary", () => {
  const secretPath = "/private/freerdc-test/secret.txt";
  const err = new FreeRdcError(E_INTERNAL, `failed at ${secretPath}`, { public: "ok" });
  assert.match(err.message, /secret\.txt/);
  const wire = err.toWire();
  assert.equal(wire.message, E_INTERNAL);
  assert.doesNotMatch(JSON.stringify(wire), /secret\.txt|freerdc-test/);
});
