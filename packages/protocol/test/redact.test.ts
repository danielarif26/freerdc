import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redact } from "../src/redact.js";

test("redact: preserves object keys exactly", () => {
  const input = {
    username: "alice",
    password: "secret123",
    API_KEY: "abc123",
    authorization: "Bearer xyz",
    my_token: "tok",
  };
  const result = redact(input) as Record<string, unknown>;

  // Keys must be preserved exactly
  assert.ok("username" in result);
  assert.ok("password" in result);
  assert.ok("API_KEY" in result);
  assert.ok("authorization" in result);
  assert.ok("my_token" in result);

  // Non-sensitive values preserved
  assert.strictEqual(result.username, "alice");

  // Sensitive key values redacted
  assert.strictEqual(result.password, "[REDACTED]");
  assert.strictEqual(result.API_KEY, "[REDACTED]");
  assert.strictEqual(result.authorization, "[REDACTED]");
  assert.strictEqual(result.my_token, "[REDACTED]");
});

test("redact: recursively redacts sensitive string values", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const bearer = "Bearer abc123def456";
  const longHex = "0123456789abcdef0123456789abcdef";
  const longBase64 = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY3ODkw";

  assert.strictEqual(redact(jwt), "[REDACTED]");
  assert.strictEqual(redact(bearer), "[REDACTED]");
  assert.strictEqual(redact(longHex), "[REDACTED]");
  assert.strictEqual(redact(longBase64), "[REDACTED]");

  // Nested in non-sensitive keys
  const nested = {
    data: jwt,
    info: bearer,
    id: longHex,
  };
  const result = redact(nested) as Record<string, unknown>;
  assert.strictEqual(result.data, "[REDACTED]");
  assert.strictEqual(result.info, "[REDACTED]");
  assert.strictEqual(result.id, "[REDACTED]");
});

test("redact: supports knownSecrets option", () => {
  const secret1 = "my-secret-value";
  const secret2 = "another-secret";
  const normal = "public-data";

  const input = {
    field1: secret1,
    field2: secret2,
    field3: normal,
  };

  const result = redact(input, { knownSecrets: [secret1, secret2] }) as Record<string, unknown>;
  assert.strictEqual(result.field1, "[REDACTED]");
  assert.strictEqual(result.field2, "[REDACTED]");
  assert.strictEqual(result.field3, "public-data");

  // Empty strings not matched
  const withEmpty = { x: "" };
  const res2 = redact(withEmpty, { knownSecrets: [""] }) as Record<string, unknown>;
  assert.strictEqual(res2.x, "");
});

test("redact: backwards compatible - existing call sites work", () => {
  const input = { password: "secret", name: "test" };
  const result = redact(input) as Record<string, unknown>;
  assert.strictEqual(result.password, "[REDACTED]");
  assert.strictEqual(result.name, "test");
});

test("redact: cycle-safe using WeakSet", () => {
  const obj: Record<string, unknown> = { name: "test" };
  obj.self = obj;

  const result = redact(obj) as Record<string, unknown>;
  assert.strictEqual(result.name, "test");
  assert.strictEqual(result.self, "[REDACTED]");
});

test("redact: depth-capped with TRUNCATED", () => {
  let nested: Record<string, unknown> = { level: 10 };
  for (let i = 9; i >= 0; i--) {
    nested = { level: i, nested };
  }

  const result = redact(nested, { maxDepth: 3 });
  assert.notStrictEqual(result, "[TRUNCATED]");

  let current = result as Record<string, unknown>;
  for (let i = 0; i <= 3; i++) {
    assert.strictEqual(current.level, i);
    if (i < 3) {
      current = current.nested as Record<string, unknown>;
    }
  }
  assert.strictEqual(current.nested, "[TRUNCATED]");
});

test("redact: no input mutation", () => {
  const input = {
    password: "secret",
    user: { token: "tok123" },
    items: ["a", "b"],
  };
  const copy = JSON.parse(JSON.stringify(input));

  redact(input);

  assert.deepStrictEqual(input, copy);
});

test("redact: arrays preserve order", () => {
  const input = ["first", { password: "secret" }, "third", "eyJ.test.sig"];
  const result = redact(input) as unknown[];

  assert.strictEqual(result[0], "first");
  assert.strictEqual((result[1] as Record<string, unknown>).password, "[REDACTED]");
  assert.strictEqual(result[2], "third");
  assert.strictEqual(result[3], "[REDACTED]");
});

test("redact: error objects replaced safely", () => {
  const err = new Error("test error");
  assert.strictEqual(redact(err), "[REDACTED]");

  const obj = { err: new Error("nested") };
  const result = redact(obj) as Record<string, unknown>;
  assert.strictEqual(result.err, "[REDACTED]");
});

test("redact: function objects replaced safely", () => {
  const fn = () => "test";
  assert.strictEqual(redact(fn), "[REDACTED]");

  const obj = { callback: fn };
  const result = redact(obj) as Record<string, unknown>;
  assert.strictEqual(result.callback, "[REDACTED]");
});

test("redact: case-insensitive sensitive keys", () => {
  const input = {
    Password: "p1",
    PASSWORD: "p2",
    PaSsWoRd: "p3",
    my_TOKEN: "t1",
    Authorization: "a1",
  };
  const result = redact(input) as Record<string, unknown>;

  // Keys preserved
  assert.ok("Password" in result);
  assert.ok("PASSWORD" in result);
  assert.ok("PaSsWoRd" in result);
  assert.ok("my_TOKEN" in result);
  assert.ok("Authorization" in result);

  // Values redacted
  assert.strictEqual(result.Password, "[REDACTED]");
  assert.strictEqual(result.PASSWORD, "[REDACTED]");
  assert.strictEqual(result.PaSsWoRd, "[REDACTED]");
  assert.strictEqual(result.my_TOKEN, "[REDACTED]");
  assert.strictEqual(result.Authorization, "[REDACTED]");
});

test("redact: all sensitive keyword variations", () => {
  const input = {
    token: "t1",
    secret: "s1",
    password: "p1",
    passwd: "p2",
    cookie: "c1",
    apikey: "k1",
    api_key: "k2",
    credential: "cr1",
    private_key: "pk1",
    session: "se1",
    device_id: "d1",
    bearer: "b1",
    user_token: "ut1",
    token_refresh: "tr1",
    my_secret_key: "msk1",
  };
  const result = redact(input) as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    assert.ok(key in result, `Key ${key} must be preserved`);
    assert.strictEqual(result[key], "[REDACTED]", `Value for ${key} must be redacted`);
  }
});

test("redact: primitives preserved when non-sensitive", () => {
  assert.strictEqual(redact("hello"), "hello");
  assert.strictEqual(redact(123), 123);
  assert.strictEqual(redact(true), true);
  assert.strictEqual(redact(false), false);
  assert.strictEqual(redact(null), null);
  assert.strictEqual(redact(undefined), undefined);
});

test("redact: strict TypeScript compatibility - no any required", () => {
  // This test verifies type narrowing works without `any`
  const input: unknown = { password: "secret", name: "test" };
  const result = redact(input);

  // Type narrowing
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    assert.strictEqual(obj.password, "[REDACTED]");
    assert.strictEqual(obj.name, "test");
  } else {
    assert.fail("Expected object result");
  }
});


test("redact: camelCase and header-style sensitive keys are redacted even for short values", () => {
  const input = {
    accessToken: "shorttok", refreshToken: "refresh1", clientSecret: "client12",
    privateKey: "private1", deviceId: "device01", "X-Api-Key": "shortkey",
  };
  const result = redact(input) as Record<string, unknown>;
  for (const key of Object.keys(input)) assert.equal(result[key], "[REDACTED]", key);
});

test("redact: repeated non-cyclic references remain readable while cycles stay contained", () => {
  const shared = { value: "public" };
  const result = redact({ first: shared, second: shared }) as Record<string, unknown>;
  assert.deepEqual(result.first, { value: "public" });
  assert.deepEqual(result.second, { value: "public" });
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal((redact(cyclic) as Record<string, unknown>).self, "[REDACTED]");
});

test("redact: bigint, symbols, and throwing getters cannot break serialization", () => {
  const value: Record<string, unknown> = { count: 123n, marker: Symbol("x") };
  Object.defineProperty(value, "hostile", { enumerable: true, get() { throw new Error("getter secret"); } });
  const result = redact(value) as Record<string, unknown>;
  assert.equal(result.count, "123");
  assert.equal(result.marker, "[REDACTED]");
  assert.equal(result.hostile, "[REDACTED]");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("redact: total node budget bounds repeated DAG expansion", () => {
  const shared = { value: "public" };
  const input = { first: shared, second: shared, third: shared };
  const result = redact(input, { maxNodes: 5 }) as Record<string, unknown>;
  assert.deepEqual(result.first, { value: "public" });
  assert.deepEqual(result.second, { value: "public" });
  assert.equal(result.third, "[TRUNCATED]");
});

test("redact: total node budget also bounds wide sensitive objects", () => {
  const result = redact({ token: "one", secret: "two", password: "three" }, { maxNodes: 3 }) as Record<string, unknown>;
  assert.deepEqual(result, { token: "[REDACTED]", secret: "[REDACTED]", password: "[TRUNCATED]" });
});

test("redact: hostile array elements and proxies are contained per element", () => {
  const array = ["safe", "unreadable", "later"];
  Object.defineProperty(array, 1, { enumerable: true, get() { throw new Error("array getter secret"); } });
  const result = redact(array) as unknown[];
  assert.deepEqual(result, ["safe", "[REDACTED]", "later"]);

  const proxied = new Proxy(["safe"], { get() { throw new Error("proxy secret"); } });
  assert.equal(redact(proxied), "[REDACTED]");
});

test("redact: correlation IDs stay visible while device/session and secret variants stay hidden", () => {
  const result = redact({
    requestId: "request-1", processId: "process-1", streamId: "stream-1", correlationId: "correlation-1",
    deviceId: "device-1", sessionId: "session-1", accessToken: "token", clientSecret: "secret",
  }) as Record<string, unknown>;
  for (const key of ["requestId", "processId", "streamId", "correlationId"]) assert.notEqual(result[key], "[REDACTED]", key);
  for (const key of ["deviceId", "sessionId", "accessToken", "clientSecret"]) assert.equal(result[key], "[REDACTED]", key);
});
