import { strict as assert } from "node:assert";
import { test } from "node:test";
import { TokenBucket } from "../src/token-bucket.js";

test("token-bucket: starts with full capacity", () => {
  const bucket = new TokenBucket(10, 1);
  assert.strictEqual(bucket["capacity"], 10);
  assert.strictEqual(bucket["tokens"], 10);
});

test("token-bucket: tryRemove consumes tokens", () => {
  let now = 0;
  const bucket = new TokenBucket(10, 1, { initialTokens: 5, clock: () => now });
  assert.strictEqual(bucket.tryRemove(1), true);
  assert.strictEqual(bucket["tokens"], 4);
  assert.strictEqual(bucket.tryRemove(4), true);
  assert.strictEqual(bucket["tokens"], 0);
  assert.strictEqual(bucket.tryRemove(1), false);
});

test("token-bucket: refills over time", () => {
  let now = 0;
  const bucket = new TokenBucket(10, 2, { clock: () => now, initialTokens: 0 });
  assert.strictEqual(bucket.tryRemove(1), false);

  now = 500; // 0.5s, 1 token
  assert.strictEqual(bucket.tryRemove(1), true);
  assert.strictEqual(bucket["tokens"], 0);

  now = 1500; // 1.5s total (1s more from consumption), 2 tokens
  assert.strictEqual(bucket.tryRemove(2), true);
  assert.strictEqual(bucket["tokens"], 0);
});

test("token-bucket: deterministic with injected clock", () => {
  let now = 0;
  const bucket = new TokenBucket(10, 1, { clock: () => now, initialTokens: 10 });
  const first = bucket.tryRemove(1);
  now = 1000;
  const second = bucket.tryRemove(1);
  assert.strictEqual(first, true);
  assert.strictEqual(second, true);
});

test("token-bucket: cannot exceed capacity", () => {
  let now = 0;
  const bucket = new TokenBucket(10, 5, { clock: () => now, initialTokens: 5 });
  now = 10000; // 10s, add 50 tokens, cap at 10
  assert.strictEqual(bucket.tryRemove(10), true);
  assert.strictEqual(bucket["tokens"], 0);
});

test("token-bucket: default arguments", () => {
  const bucket = new TokenBucket(5, 1);
  assert.strictEqual(bucket.tryRemove(5), true);
  assert.strictEqual(bucket.tryRemove(1), false);
});


test("token-bucket: rejects invalid configuration and removal costs without mutating tokens", () => {
  const invalidConfigs: Array<readonly [number, number]> = [
    [Number.NaN, 1], [0, 1], [-1, 1], [10, -1], [10, Number.NaN],
  ];
  for (const [capacity, refill] of invalidConfigs) {
    assert.throws(() => new TokenBucket(capacity, refill), RangeError);
  }
  assert.throws(() => new TokenBucket(10, 1, { initialTokens: -1 }), RangeError);
  assert.throws(() => new TokenBucket(10, 1, { initialTokens: 11 }), RangeError);
  assert.throws(() => new TokenBucket(10, 1, { clock: () => Number.NaN }), RangeError);

  const bucket = new TokenBucket(10, 0, { initialTokens: 5, clock: () => 0 });
  for (const cost of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => bucket.tryRemove(cost), RangeError);
    assert.equal(bucket["tokens"], 5);
  }
});
