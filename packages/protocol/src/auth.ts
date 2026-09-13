const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

function validateTranscriptPart(value: unknown, name: string, maximumLength: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(`${name} must be a non-empty string without control characters`);
  }
}

/** Builds the exact, domain-separated byte transcript signed by an agent. */
export function buildAgentAuthTranscript(deviceId: string, nonce: string): Buffer {
  validateTranscriptPart(deviceId, "deviceId", 128);
  validateTranscriptPart(nonce, "nonce", 256);
  return Buffer.from(`freerdc-wire/1\0agent-auth\0${deviceId}\0${nonce}`, "utf8");
}
