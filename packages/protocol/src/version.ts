export const WIRE_ID = "freerdc-wire" as const;
export const WIRE_VERSION: WireVersion = { major: 1, minor: 0 };

export type WireVersion = { major: number; minor: number };

// Capability constants
export const CAPABILITY_FS_V1 = "fs.v1" as const;
export const CAPABILITY_SEARCH_V1 = "search.v1" as const;
export const CAPABILITY_PTY_V1 = "pty.v1" as const;
export const CAPABILITY_PTY_PIPE_V1 = "pty.pipe.v1" as const;
export const CAPABILITY_PROC_V1 = "proc.v1" as const;
export const CAPABILITY_TRASH_V1 = "trash.v1" as const;
export const CAPABILITY_DRYRUN_V1 = "dryrun.v1" as const;

// All capabilities as a readonly array (useful for reference)
export const ALL_CAPABILITIES = [
  CAPABILITY_FS_V1,
  CAPABILITY_SEARCH_V1,
  CAPABILITY_PTY_V1,
  CAPABILITY_PTY_PIPE_V1,
  CAPABILITY_PROC_V1,
  CAPABILITY_TRASH_V1,
  CAPABILITY_DRYRUN_V1,
] as const;

export type NegotiateResult =
  | { ok: true; version: WireVersion; capabilities: string[] }
  | { ok: false; error: 'E_PROTOCOL_VERSION' | 'E_CAPABILITY_UNSUPPORTED'; details: { local: WireVersion; remote: WireVersion } | { missing: string[] } };

export type NegotiateLocalInput = {
  version: WireVersion;
  supported: string[];
  required?: string[];
};

export type NegotiateRemoteInput = {
  version: WireVersion;
  supported: string[];
};

export function negotiate(
  local: NegotiateLocalInput,
  remote: NegotiateRemoteInput
): NegotiateResult {
  // Major mismatch → hard reject
  if (local.version.major !== remote.version.major) {
    return {
      ok: false,
      error: 'E_PROTOCOL_VERSION',
      details: {
        local: local.version,
        remote: remote.version,
      },
    };
  }

  // Minor: accept, effective minor = min(local.minor, remote.minor)
  const effectiveMinor = Math.min(local.version.minor, remote.version.minor);
  const effectiveVersion: WireVersion = { major: local.version.major, minor: effectiveMinor };

  // Capabilities: deterministic Set intersection based on local supported order
  const remoteSet = new Set(remote.supported);
  const seen = new Set<string>();
  const intersection: string[] = [];
  for (const cap of local.supported) {
    if (!seen.has(cap) && remoteSet.has(cap)) {
      seen.add(cap);
      intersection.push(cap);
    }
  }

  // Required capabilities check (deduplicate in local required order)
  const required = local.required ?? [];
  // Deduplicate required array while preserving order
  const seenRequired = new Set<string>();
  const deduplicatedRequired: string[] = [];
  for (const cap of required) {
    if (!seenRequired.has(cap)) {
      seenRequired.add(cap);
      deduplicatedRequired.push(cap);
    }
  }
  const missing = deduplicatedRequired.filter((cap) => !remoteSet.has(cap));
  if (missing.length > 0) {
    return {
      ok: false,
      error: 'E_CAPABILITY_UNSUPPORTED',
      details: {
        missing,
      },
    };
  }

  return {
    ok: true,
    version: effectiveVersion,
    capabilities: intersection,
  };
}
