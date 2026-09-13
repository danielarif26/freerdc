import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentAuthTranscript } from "../src/auth.js";

test("buildAgentAuthTranscript produces the exact domain-separated UTF-8 bytes", () => {
  const transcript = buildAgentAuthTranscript("device-1", "nonce-1");
  assert.ok(Buffer.isBuffer(transcript));
  assert.deepEqual(
    transcript,
    Buffer.from("freerdc-wire/1\0agent-auth\0device-1\0nonce-1", "utf8")
  );
});

test("buildAgentAuthTranscript is deterministic and binds both inputs", () => {
  const first = buildAgentAuthTranscript("device-1", "nonce-1");
  const second = buildAgentAuthTranscript("device-1", "nonce-1");
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, buildAgentAuthTranscript("device-2", "nonce-1"));
  assert.notDeepEqual(first, buildAgentAuthTranscript("device-1", "nonce-2"));
});

test("buildAgentAuthTranscript rejects invalid device IDs and nonces", () => {
  for (const deviceId of ["", "a".repeat(129), "device\0id", "device\n-id", 42] as const) {
    assert.throws(() => buildAgentAuthTranscript(deviceId as string, "nonce-1"), TypeError);
  }
  for (const nonce of ["", "a".repeat(257), "nonce\0value", "nonce\tvalue", 42] as const) {
    assert.throws(() => buildAgentAuthTranscript("device-1", nonce as string), TypeError);
  }
});
