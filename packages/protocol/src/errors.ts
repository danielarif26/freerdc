import { redact } from "./redact.js";

export const ERROR_CODES = {
  E_PROTOCOL_VERSION: "E_PROTOCOL_VERSION",
  E_CAPABILITY_UNSUPPORTED: "E_CAPABILITY_UNSUPPORTED",
  E_MALFORMED_MESSAGE: "E_MALFORMED_MESSAGE",
  E_UNAUTHORIZED: "E_UNAUTHORIZED",
  E_PATH_DENIED: "E_PATH_DENIED",
  E_PATH_ESCAPE: "E_PATH_ESCAPE",
  E_CMD_DENIED: "E_CMD_DENIED",
  E_RATE_LIMITED: "E_RATE_LIMITED",
  E_CONCURRENCY_LIMIT: "E_CONCURRENCY_LIMIT",
  E_DEVICE_OFFLINE: "E_DEVICE_OFFLINE",
  E_KILLSWITCH: "E_KILLSWITCH",
  E_TOO_LARGE: "E_TOO_LARGE",
  E_TIMEOUT: "E_TIMEOUT",
  E_STALE_HASH: "E_STALE_HASH",
  E_INTERNAL: "E_INTERNAL",
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export const E_PROTOCOL_VERSION = ERROR_CODES.E_PROTOCOL_VERSION;
export const E_CAPABILITY_UNSUPPORTED = ERROR_CODES.E_CAPABILITY_UNSUPPORTED;
export const E_MALFORMED_MESSAGE = ERROR_CODES.E_MALFORMED_MESSAGE;
export const E_UNAUTHORIZED = ERROR_CODES.E_UNAUTHORIZED;
export const E_PATH_DENIED = ERROR_CODES.E_PATH_DENIED;
export const E_PATH_ESCAPE = ERROR_CODES.E_PATH_ESCAPE;
export const E_CMD_DENIED = ERROR_CODES.E_CMD_DENIED;
export const E_RATE_LIMITED = ERROR_CODES.E_RATE_LIMITED;
export const E_CONCURRENCY_LIMIT = ERROR_CODES.E_CONCURRENCY_LIMIT;
export const E_DEVICE_OFFLINE = ERROR_CODES.E_DEVICE_OFFLINE;
export const E_KILLSWITCH = ERROR_CODES.E_KILLSWITCH;
export const E_TOO_LARGE = ERROR_CODES.E_TOO_LARGE;
export const E_TIMEOUT = ERROR_CODES.E_TIMEOUT;
export const E_STALE_HASH = ERROR_CODES.E_STALE_HASH;
export const E_INTERNAL = ERROR_CODES.E_INTERNAL;

export const E_UNSUPPORTED_CAPABILITY = E_CAPABILITY_UNSUPPORTED;
export const E_ROOT_ESCAPE = E_PATH_ESCAPE;
export const E_RATE_LIMIT = E_RATE_LIMITED;

export class FreeRdcError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode);
  constructor(code: ErrorCode, details: Record<string, unknown>);
  constructor(code: ErrorCode, safeMessage: string, details?: Record<string, unknown>);
  constructor(code: ErrorCode, arg2?: string | Record<string, unknown>, arg3?: Record<string, unknown>) {
    let safeMessage: string;
    let actualDetails: Record<string, unknown> | undefined;

    if (isRecord(arg2)) {
      safeMessage = code;
      actualDetails = arg2;
    } else {
      safeMessage = arg2 ?? code;
      actualDetails = arg3;
    }

    super(safeMessage ?? code);
    this.code = code;
    this.details = actualDetails;
    this.name = "FreeRdcError";
  }

  toWire(): { code: string; message: string; details?: Record<string, unknown> } {
    // Custom Error.message text is useful locally, but it is not a safe wire
    // contract: callers can accidentally interpolate paths, commands, or
    // upstream secrets. Only the canonical code crosses the boundary.
    const wireMessage = this.code;
    if (this.details === undefined) {
      return { code: this.code, message: wireMessage };
    }
    const redacted = redact(this.details);
    if (redacted === null || Array.isArray(redacted) || typeof redacted !== "object") {
      return { code: this.code, message: wireMessage };
    }
    return { code: this.code, message: wireMessage, details: redacted as Record<string, unknown> };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
