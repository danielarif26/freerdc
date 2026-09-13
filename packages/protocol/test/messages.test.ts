import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnvelope } from "../src/messages.js";
import { FreeRdcError, E_MALFORMED_MESSAGE } from "../src/errors.js";

test("parseEnvelope accepts hello frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-001",
    kind: "hello",
    ts: 1234567890,
    payload: {
      type: "hello",
      wireId: "wire-abc",
      version: { major: 1, minor: 0 },
      capabilities: ["stream", "rpc"],
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "hello");
    assert.equal(result.frame.type, "hello");
  }
});

test("parseEnvelope accepts hello frame with deviceId", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-hello-device",
    kind: "hello",
    ts: 1234567890,
    payload: {
      type: "hello",
      wireId: "wire-abc",
      deviceId: "device-abc",
      version: { major: 1, minor: 0 },
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.frame.deviceId, "device-abc");
  }
});

test("parseEnvelope accepts challenge frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-002",
    kind: "challenge",
    ts: 1234567891,
    payload: {
      type: "challenge",
      nonce: "random-nonce-123",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "challenge");
    assert.equal(result.frame.type, "challenge");
  }
});

test("parseEnvelope accepts auth frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-003",
    kind: "auth",
    ts: 1234567892,
    payload: {
      type: "auth",
      signature: "fake-signature",
      wireId: "wire-def",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "auth");
    assert.equal(result.frame.type, "auth");
  }
});

test("parseEnvelope accepts ready frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-004",
    kind: "ready",
    ts: 1234567893,
    payload: {
      type: "ready",
      capabilities: ["exec", "fs"],
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "ready");
    assert.equal(result.frame.type, "ready");
  }
});

test("parseEnvelope accepts rpc.req frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-005",
    kind: "rpc.req",
    ts: 1234567894,
    payload: {
      type: "rpc.req",
      requestId: "req-123",
      method: "fs.read",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "rpc.req");
    assert.equal(result.frame.type, "rpc.req");
  }
});

test("parseEnvelope accepts rpc.req frame with params", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-rpc-params",
    kind: "rpc.req",
    ts: 1234567894,
    payload: {
      type: "rpc.req",
      requestId: "req-params",
      method: "fs.read",
      params: { path: "/tmp/example", recursive: false },
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.deepEqual(result.frame.params, { path: "/tmp/example", recursive: false });
  }
});

test("parseEnvelope accepts rpc.res frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-006",
    kind: "rpc.res",
    ts: 1234567895,
    payload: {
      type: "rpc.res",
      requestId: "req-123",
      result: { data: "success" },
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "rpc.res");
    assert.equal(result.frame.type, "rpc.res");
  }
});

test("parseEnvelope accepts rpc.err frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-007",
    kind: "rpc.err",
    ts: 1234567896,
    payload: {
      type: "rpc.err",
      requestId: "req-123",
      error: { code: "E_NOT_FOUND" },
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "rpc.err");
    assert.equal(result.frame.type, "rpc.err");
  }
});

test("parseEnvelope accepts stream.open frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-008",
    kind: "stream.open",
    ts: 1234567897,
    payload: {
      type: "stream.open",
      streamId: "stream-xyz",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "stream.open");
    assert.equal(result.frame.type, "stream.open");
  }
});

test("parseEnvelope accepts stream.chunk frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-009",
    kind: "stream.chunk",
    ts: 1234567898,
    payload: {
      type: "stream.chunk",
      streamId: "stream-xyz",
      seq: 42,
      data: "chunk-content",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "stream.chunk");
    assert.equal(result.frame.type, "stream.chunk");
  }
});

test("parseEnvelope accepts stream.ack frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-010",
    kind: "stream.ack",
    ts: 1234567899,
    payload: {
      type: "stream.ack",
      streamId: "stream-xyz",
      seq: 42,
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "stream.ack");
    assert.equal(result.frame.type, "stream.ack");
  }
});

test("parseEnvelope accepts cancel frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-011",
    kind: "cancel",
    ts: 1234567900,
    payload: {
      type: "cancel",
      requestId: "req-456",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "cancel");
    assert.equal(result.frame.type, "cancel");
  }
});

test("parseEnvelope accepts ping frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-012",
    kind: "ping",
    ts: 1234567901,
    payload: {
      type: "ping",
      nonce: "ping-nonce",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "ping");
    assert.equal(result.frame.type, "ping");
  }
});

test("parseEnvelope accepts pong frame", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-013",
    kind: "pong",
    ts: 1234567902,
    payload: {
      type: "pong",
      nonce: "pong-nonce",
    },
  });
  assert.equal(result.status, "known");
  if (result.status === "known") {
    assert.equal(result.kind, "pong");
    assert.equal(result.frame.type, "pong");
  }
});

test("parseEnvelope safely returns unknown future frame kind", () => {
  const result = parseEnvelope({
    v: "freerdc-wire/1",
    id: "msg-999",
    kind: "future.feature",
    ts: 1234567903,
    payload: { type: "future.feature", data: "unknown" },
  });
  assert.equal(result.status, "unknown");
  if (result.status === "unknown") {
    assert.equal(result.kind, "future.feature");
    assert.deepEqual(result.payload, { type: "future.feature", data: "unknown" });
  }
});

test("parseEnvelope throws on bad wire version", () => {
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/2",
        id: "msg-bad",
        kind: "hello",
        ts: 1234567904,
        payload: { type: "hello" },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      return true;
    }
  );
});

test("parseEnvelope throws on malformed known payload with validation path", () => {
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "msg-bad",
        kind: "hello",
        ts: 1234567905,
        payload: { type: "hello" },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      const details = (err as FreeRdcError).details;
      assert.ok(details);
      assert.ok(typeof details.frameError === "string");
      assert.ok((details.frameError as string).includes("wireId"));
      return true;
    }
  );
});

test("parseEnvelope throws on type/kind mismatch", () => {
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "msg-mismatch",
        kind: "hello",
        ts: 1234567906,
        payload: {
          type: "challenge",
          nonce: "wrong",
        },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      return true;
    }
  );
});

test("parseEnvelope validation error does not leak secret values", () => {
  const SECRET_VALUE = "super-secret-token-12345";
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "msg-leak",
        kind: "auth",
        ts: 1234567907,
        payload: {
          type: "auth",
          signature: SECRET_VALUE,
        },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      const details = (err as FreeRdcError).details;
      assert.ok(details);
      const frameError = details.frameError as string;
      assert.ok(!frameError.includes(SECRET_VALUE), "Secret value leaked in error");
      assert.ok(frameError.includes("wireId"), "Should include field path");
      return true;
    }
  );
});

test("parseEnvelope rejects malformed deviceId without echoing it", () => {
  const deviceId = "x".repeat(129);
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "msg-bad-device",
        kind: "hello",
        ts: 1234567907,
        payload: {
          type: "hello",
          wireId: "wire-abc",
          deviceId,
          version: { major: 1, minor: 0 },
        },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      const details = (err as FreeRdcError).details;
      assert.ok(details);
      const frameError = details.frameError as string;
      assert.ok(frameError.includes("deviceId"));
      assert.ok(!frameError.includes(deviceId));
      return true;
    }
  );
});

test("parseEnvelope throws on empty id", () => {
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "",
        kind: "ping",
        ts: 1234567908,
        payload: { type: "ping" },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      return true;
    }
  );
});

test("parseEnvelope throws on empty kind", () => {
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "msg-empty-kind",
        kind: "",
        ts: 1234567909,
        payload: { type: "ping" },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      return true;
    }
  );
});

test("parseEnvelope throws on non-finite timestamp", () => {
  assert.throws(
    () => {
      parseEnvelope({
        v: "freerdc-wire/1",
        id: "msg-inf",
        kind: "ping",
        ts: Infinity,
        payload: { type: "ping" },
      });
    },
    (err: Error) => {
      assert.ok(err instanceof FreeRdcError);
      assert.equal((err as FreeRdcError).code, E_MALFORMED_MESSAGE);
      return true;
    }
  );
});


test("parseEnvelope treats prototype-named frame kinds as unknown without throwing", () => {
  for (const kind of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
    const result = parseEnvelope({ v: "freerdc-wire/1", id: `prototype-${kind}`, kind, ts: 0, payload: {} });
    assert.equal(result.status, "unknown", kind);
  }
});

test("parseEnvelope rejects invalid handshake numbers, stream sequences, and challenge nonces", () => {
  const invalid = [
    { kind: "hello", payload: { type: "hello", wireId: "wire", version: { major: -1, minor: 0 } } },
    { kind: "hello", payload: { type: "hello", wireId: "wire", version: { major: 1.5, minor: 0 } } },
    { kind: "hello-ack", payload: { type: "hello-ack", version: { major: Infinity, minor: 0 } } },
    { kind: "stream.chunk", payload: { type: "stream.chunk", streamId: "s", seq: -1, data: "x" } },
    { kind: "stream.ack", payload: { type: "stream.ack", streamId: "s", seq: 1.5 } },
    { kind: "challenge", payload: { type: "challenge", nonce: "" } },
    { kind: "challenge", payload: { type: "challenge", nonce: "bad\nnonce" } },
    { kind: "challenge", payload: { type: "challenge", nonce: "x".repeat(257) } },
  ];
  for (const [index, frame] of invalid.entries()) {
    assert.throws(
      () => parseEnvelope({ v: "freerdc-wire/1", id: `invalid-${index}`, kind: frame.kind, ts: 0, payload: frame.payload }),
      (error: unknown) => error instanceof FreeRdcError && error.code === E_MALFORMED_MESSAGE,
    );
  }
});
