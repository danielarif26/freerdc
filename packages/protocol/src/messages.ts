import { z } from "zod";
import { FreeRdcError, E_MALFORMED_MESSAGE } from "./errors.js";

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;
const WIRE_UINT = z.number().finite().int().nonnegative();
const SAFE_NONCE = z.string().min(1).max(256).refine((value) => !CONTROL_CHARACTER.test(value));

const ENVELOPE_BASE = z.object({
  v: z.literal("freerdc-wire/1"),
  id: z.string().min(1),
  kind: z.string().min(1),
  ts: z.number().finite(),
  payload: z.unknown(),
});

// Handshake frames
export const HELLO_FRAME = z.object({
  type: z.literal("hello"),
  wireId: z.string(),
  deviceId: z.string().min(1).max(128).optional(),
  version: z.object({ major: WIRE_UINT, minor: WIRE_UINT }),
  capabilities: z.array(z.string()).optional(),
}).passthrough();

export const CHALLENGE_FRAME = z.object({
  type: z.literal("challenge"),
  nonce: SAFE_NONCE,
}).passthrough();

export const AUTH_FRAME = z.object({
  type: z.literal("auth"),
  signature: z.string(),
  wireId: z.string(),
}).passthrough();

export const READY_FRAME = z.object({
  type: z.literal("ready"),
  version: z.object({
    major: z.number().finite().int().nonnegative(),
    minor: z.number().finite().int().nonnegative(),
  }).optional(),
  capabilities: z.array(z.string()).optional(),
}).passthrough();

// RPC frames
export const RPC_REQ_FRAME = z.object({
  type: z.literal("rpc.req"),
  requestId: z.string(),
  method: z.string(),
  params: z.unknown().optional(),
}).passthrough();

export const RPC_RES_FRAME = z.object({
  type: z.literal("rpc.res"),
  requestId: z.string(),
  result: z.unknown(),
}).passthrough();

export const RPC_ERR_FRAME = z.object({
  type: z.literal("rpc.err"),
  requestId: z.string(),
  error: z.unknown(),
}).passthrough();

// Stream frames
export const STREAM_OPEN_FRAME = z.object({
  type: z.literal("stream.open"),
  streamId: z.string(),
}).passthrough();

export const STREAM_CHUNK_FRAME = z.object({
  type: z.literal("stream.chunk"),
  streamId: z.string(),
  seq: WIRE_UINT,
  data: z.unknown(),
}).passthrough();

export const STREAM_ACK_FRAME = z.object({
  type: z.literal("stream.ack"),
  streamId: z.string(),
  seq: WIRE_UINT,
}).passthrough();

// Control frames
export const CANCEL_FRAME = z.object({
  type: z.literal("cancel"),
  requestId: z.string(),
}).passthrough();

export const PING_FRAME = z.object({
  type: z.literal("ping"),
  nonce: z.string().optional(),
}).passthrough();

export const PONG_FRAME = z.object({
  type: z.literal("pong"),
  nonce: z.string().optional(),
}).passthrough();

// Legacy aliases (harmless retention)
export const HELLO_ACK_FRAME = z.object({
  type: z.literal("hello-ack"),
  version: z.object({ major: WIRE_UINT, minor: WIRE_UINT }),
  capabilities: z.array(z.string()).optional(),
}).passthrough();

export const ERROR_FRAME = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string().optional(),
  details: z.record(z.unknown()).optional(),
}).passthrough();

const FRAME_SCHEMAS = {
  hello: HELLO_FRAME,
  challenge: CHALLENGE_FRAME,
  auth: AUTH_FRAME,
  ready: READY_FRAME,
  "rpc.req": RPC_REQ_FRAME,
  "rpc.res": RPC_RES_FRAME,
  "rpc.err": RPC_ERR_FRAME,
  "stream.open": STREAM_OPEN_FRAME,
  "stream.chunk": STREAM_CHUNK_FRAME,
  "stream.ack": STREAM_ACK_FRAME,
  cancel: CANCEL_FRAME,
  ping: PING_FRAME,
  pong: PONG_FRAME,
  "hello-ack": HELLO_ACK_FRAME,
  error: ERROR_FRAME,
} as const;

type KnownFrameKind = keyof typeof FRAME_SCHEMAS;

type ParsedFrame<K extends KnownFrameKind> = z.infer<typeof FRAME_SCHEMAS[K]>;

export type ParsedEnvelope =
  | { status: "known"; envelope: z.infer<typeof ENVELOPE_BASE>; kind: KnownFrameKind; frame: ParsedFrame<KnownFrameKind> }
  | { status: "unknown"; envelope: z.infer<typeof ENVELOPE_BASE>; kind: string; payload: unknown };

function isKnownFrameKind(kind: string): kind is KnownFrameKind {
  return Object.prototype.hasOwnProperty.call(FRAME_SCHEMAS, kind);
}

function parseFrame(kind: KnownFrameKind, payload: unknown): { ok: true; data: ParsedFrame<KnownFrameKind> } | { ok: false; error: string } {
  const schema = FRAME_SCHEMAS[kind];
  const result = schema.safeParse(payload);
  if (!result.success) {
    const summary = result.error.issues
      .map((i) => `${i.path.join(".")} - ${i.code}`)
      .join(", ");
    return { ok: false, error: summary };
  }
  return { ok: true, data: result.data as ParsedFrame<KnownFrameKind> };
}

export function parseEnvelope(input: unknown): ParsedEnvelope {
  const envelopeResult = ENVELOPE_BASE.safeParse(input);
  if (!envelopeResult.success) {
    const summary = envelopeResult.error.issues
      .map((i) => `${i.path.join(".")} - ${i.code}`)
      .join(", ");
    throw new FreeRdcError(E_MALFORMED_MESSAGE, { issues: summary });
  }

  const envelope = envelopeResult.data;
  if (!isKnownFrameKind(envelope.kind)) {
    return {
      status: "unknown",
      envelope,
      kind: envelope.kind,
      payload: envelope.payload,
    };
  }

  const frameResult = parseFrame(envelope.kind, envelope.payload);
  if (!frameResult.ok) {
    throw new FreeRdcError(E_MALFORMED_MESSAGE, {
      frameError: frameResult.error,
    });
  }

  return {
    status: "known",
    envelope,
    kind: envelope.kind,
    frame: frameResult.data,
  };
}
