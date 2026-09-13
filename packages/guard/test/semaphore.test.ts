import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Semaphore } from "../src/semaphore.js";

test("semaphore: constructor requires positive integer capacity", () => {
  assert.throws(() => new Semaphore(0), RangeError);
  assert.throws(() => new Semaphore(-1), RangeError);
  assert.throws(() => new Semaphore(1.5), RangeError);
  assert.throws(() => new Semaphore(NaN), RangeError);
  assert.doesNotThrow(() => new Semaphore(1));
  assert.doesNotThrow(() => new Semaphore(10));
});

test("semaphore: capacity limit enforced with FIFO queue", async () => {
  const sem = new Semaphore(2);
  const acquired: string[] = [];
  const releases: (() => void)[] = [];

  // Acquire 4 slots, only 2 should be active immediately
  const p1 = sem.acquire().then((release) => {
    acquired.push("a");
    releases.push(release);
  });
  const p2 = sem.acquire().then((release) => {
    acquired.push("b");
    releases.push(release);
  });
  const p3 = sem.acquire().then((release) => {
    acquired.push("c");
    releases.push(release);
  });
  const p4 = sem.acquire().then((release) => {
    acquired.push("d");
    releases.push(release);
  });

  // Wait for first two to actually acquire
  await Promise.all([p1, p2]);

  // First two should be acquired
  assert.deepStrictEqual(acquired, ["a", "b"]);
  assert.strictEqual(sem.stats.active, 2);
  assert.strictEqual(sem.stats.waiting, 2);

  // Release first slot
  releases[0]!();
  await p3;

  // Third should be acquired now
  assert.deepStrictEqual(acquired, ["a", "b", "c"]);
  assert.strictEqual(sem.stats.active, 2);
  assert.strictEqual(sem.stats.waiting, 1);

  // Release second slot
  releases[1]!();
  await p4;

  // Fourth should be acquired
  assert.deepStrictEqual(acquired, ["a", "b", "c", "d"]);
  assert.strictEqual(sem.stats.active, 2);
  assert.strictEqual(sem.stats.waiting, 0);

  // Release remaining
  releases[2]!();
  releases[3]!();
  await Promise.resolve();

  assert.strictEqual(sem.stats.active, 0);
  assert.strictEqual(sem.stats.waiting, 0);
});

test("semaphore: each release closure is independently idempotent", async () => {
  const sem = new Semaphore(2);

  const release1 = await sem.acquire();
  const release2 = await sem.acquire();

  assert.strictEqual(sem.stats.active, 2);

  // Double-release first lease multiple times
  release1();
  release1();
  release1();

  await Promise.resolve();

  // Only one slot should be freed
  assert.strictEqual(sem.stats.active, 1);

  // Second lease still active and can be released independently
  release2();
  await Promise.resolve();

  assert.strictEqual(sem.stats.active, 0);

  // Further releases are no-ops
  release1();
  release2();
  await Promise.resolve();

  assert.strictEqual(sem.stats.active, 0);
});

test("semaphore: stats track active and waiting accurately", async () => {
  const sem = new Semaphore(2);
  assert.strictEqual(sem.stats.active, 0);
  assert.strictEqual(sem.stats.waiting, 0);

  const r1 = await sem.acquire();
  assert.strictEqual(sem.stats.active, 1);
  assert.strictEqual(sem.stats.waiting, 0);

  const r2 = await sem.acquire();
  assert.strictEqual(sem.stats.active, 2);
  assert.strictEqual(sem.stats.waiting, 0);

  // Third acquire should queue
  const p3 = sem.acquire();
  await Promise.resolve();
  assert.strictEqual(sem.stats.active, 2);
  assert.strictEqual(sem.stats.waiting, 1);

  // Release one slot
  r1();
  const r3 = await p3;
  assert.strictEqual(sem.stats.active, 2);
  assert.strictEqual(sem.stats.waiting, 0);

  // Clean up
  r2();
  r3();
  await Promise.resolve();
  assert.strictEqual(sem.stats.active, 0);
  assert.strictEqual(sem.stats.waiting, 0);
});

test("semaphore: drain grants as many queued waiters as available capacity", async () => {
  const sem = new Semaphore(3);

  // Fill capacity
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  const r3 = await sem.acquire();

  assert.strictEqual(sem.stats.active, 3);
  assert.strictEqual(sem.stats.waiting, 0);

  // Queue 3 more
  const p4 = sem.acquire();
  const p5 = sem.acquire();
  const p6 = sem.acquire();
  await Promise.resolve();

  assert.strictEqual(sem.stats.active, 3);
  assert.strictEqual(sem.stats.waiting, 3);

  // Release all 3 slots
  r1();
  r2();
  r3();

  // All queued should be granted
  const r4 = await p4;
  const r5 = await p5;
  const r6 = await p6;

  assert.strictEqual(sem.stats.active, 3);
  assert.strictEqual(sem.stats.waiting, 0);

  // Clean up
  r4();
  r5();
  r6();
});
