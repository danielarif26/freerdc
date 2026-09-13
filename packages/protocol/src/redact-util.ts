export const REDACTED = "[REDACTED]" as const;
export const TRUNCATED = "[TRUNCATED]" as const;
export const MAX_DEPTH = 8;
export const MAX_NODES = 10_000;

const SENSITIVE_KEYWORDS = [
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "credential",
  "private_key",
  "session",
  "device_id",
  "bearer",
] as const;

const JWT_PATTERN = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*$/;
const BEARER_PATTERN = /^Bearer\s+/i;
const HEX_PATTERN = /^[0-9a-fA-F]{32,}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{32,}={0,2}$/;

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  for (const keyword of SENSITIVE_KEYWORDS) {
    for (const candidate of [lower, normalized]) {
      if (
        candidate === keyword ||
        candidate.startsWith(keyword + "_") ||
        candidate.endsWith("_" + keyword) ||
        candidate.includes("_" + keyword + "_")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isSensitiveValue(val: unknown): boolean {
  if (typeof val !== "string" || val.length === 0) return false;
  if (JWT_PATTERN.test(val)) return true;
  if (BEARER_PATTERN.test(val)) return true;
  if (HEX_PATTERN.test(val)) return true;
  if (BASE64URL_PATTERN.test(val)) return true;
  return false;
}

export function isKnownSecret(val: unknown, knownSecrets: readonly string[]): boolean {
  if (typeof val !== "string" || val.length === 0) return false;
  return knownSecrets.includes(val);
}
