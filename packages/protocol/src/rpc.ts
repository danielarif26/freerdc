import { z } from "zod";
import { FreeRdcError, E_MALFORMED_MESSAGE } from "./errors.js";

export const RPC_METHODS = Object.freeze([
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
] as const);

export type RpcMethod = (typeof RPC_METHODS)[number];

/** Maximum serialized WebSocket wire frame accepted by either peer. */
export const WIRE_MAX_FRAME_BYTES = 262_144;
/** Leave room for the envelope and RPC metadata around a serialized payload. */
const WIRE_PAYLOAD_HEADROOM_BYTES = 16_384;
export const WIRE_MAX_PAYLOAD_BYTES = WIRE_MAX_FRAME_BYTES - WIRE_PAYLOAD_HEADROOM_BYTES;
export const WIRE_MAX_STRING_LENGTH = 4_096;
export const WIRE_MAX_ARG_LENGTH = 65_536;
export const WIRE_MAX_ARG_COUNT = 128;

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === "string" && (RPC_METHODS as readonly string[]).includes(value);
}

/** Standard padded Base64; must round-trip exactly through Buffer. Empty is allowed only when that round-trip is exact. */
export function isCanonicalBase64(value: string): boolean {
  return Buffer.from(value, "base64").toString("base64") === value;
}

/** Returns true iff value is valid UTF-8 and round-trips exactly through Buffer (rejects lone surrogates, overlong, etc.). */
export function isCanonicalUtf8(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

export const WireBytes = z
  .object({
    encoding: z.enum(["utf8", "base64"]),
    data: z.string().max(WIRE_MAX_PAYLOAD_BYTES),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A character limit alone is insufficient for multi-byte UTF-8 or JSON
    // escaping. Keep the encoded WireBytes object below the payload budget so
    // the frame envelope still has bounded room on either transport.
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > WIRE_MAX_PAYLOAD_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: WIRE_MAX_PAYLOAD_BYTES,
        type: "string",
        inclusive: true,
        path: ["data"],
      });
    }
    if (value.encoding === "base64" && !isCanonicalBase64(value.data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
      });
    }
    if (value.encoding === "utf8" && !isCanonicalUtf8(value.data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
      });
    }
  });

export type WireBytes = z.infer<typeof WireBytes>;

const nonemptyString = z.string().min(1).max(WIRE_MAX_STRING_LENGTH);
const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);
const absolutePath = z.string().min(1).max(WIRE_MAX_STRING_LENGTH).refine((s) => s.startsWith("/"), {
  message: "executable must be an absolute path",
});
const dryRun = z.enum(["off", "plan"]).default("off");
const pathOnly = z.object({ path: nonemptyString }).strict();

export const RPC_PARAM_SCHEMAS: Readonly<Record<RpcMethod, z.ZodTypeAny>> = Object.freeze({
  "fs.stat": pathOnly,
  "fs.list": pathOnly,
  "fs.read": pathOnly,
  "fs.search": z
    .object({
      path: nonemptyString,
      query: nonemptyString,
      caseSensitive: z.boolean().optional(),
      maxDepth: z.number().int().nonnegative().optional(),
    })
    .strict(),
  "fs.mkdir": z
    .object({
      path: nonemptyString,
      dryRun,
    })
    .strict(),
  "fs.write": z
    .object({
      path: nonemptyString,
      content: WireBytes,
      expectedSha256: sha256.optional(),
      dryRun,
    })
    .strict(),
  "fs.delete": z
    .object({
      path: nonemptyString,
      expectedSha256: sha256,
      dryRun,
    })
    .strict(),
  "fs.move": z
    .object({
      source: nonemptyString,
      destination: nonemptyString,
      expectedSha256: sha256,
      dryRun,
    })
    .strict(),
  "proc.start": z
    .object({
      executable: absolutePath,
      argv: z.array(z.string().max(WIRE_MAX_ARG_LENGTH)).max(WIRE_MAX_ARG_COUNT).default([]),
      cwd: nonemptyString.optional(),
      timeoutMs: z.number().int().positive().optional(),
      dryRun,
    })
    .strict(),
  "proc.read": z.object({ id: nonemptyString }).strict(),
  "proc.input": z
    .object({
      id: nonemptyString,
      data: WireBytes,
    })
    .strict(),
  "proc.kill": z
    .object({
      id: nonemptyString,
      force: z.boolean().default(false),
    })
    .strict(),
  "proc.list": z.object({}).strict(),
});

export function parseRpcParams(method: RpcMethod, input: unknown): unknown {
  const schema = RPC_PARAM_SCHEMAS[method];
  const result = schema?.safeParse(input);
  if (result === undefined || !result.success) {
    throw new FreeRdcError(E_MALFORMED_MESSAGE);
  }
  return result.data;
}
