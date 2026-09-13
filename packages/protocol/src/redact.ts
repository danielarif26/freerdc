import {
  REDACTED,
  TRUNCATED,
  MAX_DEPTH,
  MAX_NODES,
  isSensitiveKey,
  isSensitiveValue,
  isKnownSecret,
} from "./redact-util.js";

export interface RedactOptions {
  readonly knownSecrets?: readonly string[];
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export function redact(value: unknown, options?: RedactOptions): unknown {
  const maxDepth = options?.maxDepth ?? MAX_DEPTH;
  const maxNodes = options?.maxNodes ?? MAX_NODES;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new RangeError("maxNodes must be a positive safe integer");
  }
  const knownSecrets = options?.knownSecrets ?? [];
  const seen = new WeakSet<object>();
  let nodes = 0;

  function redactInternal(val: unknown, depth: number): unknown {
    if (nodes >= maxNodes) return TRUNCATED;
    nodes += 1;
    if (val === null || val === undefined) return val;
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val;
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "symbol") return REDACTED;

    // Strings: check if sensitive
    if (typeof val === "string") {
      if (isKnownSecret(val, knownSecrets)) return REDACTED;
      if (isSensitiveValue(val)) return REDACTED;
      return val;
    }

    // Functions and errors replaced safely
    if (typeof val === "function") return REDACTED;
    if (val instanceof Error) return REDACTED;

    // Depth check for composite values only
    if (depth > maxDepth) return TRUNCATED;

    // Arrays: preserve order, handle cycles
    if (Array.isArray(val)) {
      if (seen.has(val)) return REDACTED;
      seen.add(val);
      try {
        let length: number;
        try {
          length = val.length;
        } catch {
          return REDACTED;
        }
        // Do not allocate or traverse beyond the total output node budget when
        // an array proxy reports an implausible length.
        if (!Number.isSafeInteger(length) || length < 0 || length > maxNodes - nodes) return TRUNCATED;
        const result = new Array<unknown>(length);
        for (let index = 0; index < length; index += 1) {
          try {
            if (!(index in val)) continue;
            result[index] = redactInternal(val[index], depth + 1);
          } catch {
            result[index] = REDACTED;
          }
        }
        return result;
      } finally {
        seen.delete(val);
      }
    }

    // Objects: preserve keys, redact sensitive values, and contain hostile getters.
    if (typeof val === "object") {
      if (seen.has(val)) return REDACTED;
      seen.add(val);
      try {
        const result: Record<string, unknown> = {};
        const record = val as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (nodes >= maxNodes) {
            result[key] = TRUNCATED;
            break;
          }
          if (isSensitiveKey(key)) {
            nodes += 1;
            result[key] = REDACTED;
            continue;
          }
          try {
            result[key] = redactInternal(record[key], depth + 1);
          } catch {
            result[key] = REDACTED;
          }
        }
        return result;
      } finally {
        seen.delete(val);
      }
    }

    // Other types (bigint, symbol, etc.)
    return val;
  }

  try {
    return redactInternal(value, 0);
  } catch {
    return REDACTED;
  }
}
