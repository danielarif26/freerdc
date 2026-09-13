import * as path from "path";
import * as fs from "fs";
import { homedir } from "os";
import { fileURLToPath } from "url";

const HOME_DIRECTORY = homedir();

// Locate the FreeRDC source checkout or installed application containing this
// module. This protects the complete code root, not merely its .git metadata.
export function getFreeRdcCodeRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === "freerdc") return current;
    } catch {
      // Continue looking for the enclosing checkout or installation root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // A packaged module without an application manifest is still part of this
  // installation. Its package root is the narrowest safe fallback.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export const DEFAULT_DENYLIST = [
  path.join(HOME_DIRECTORY, ".freerdc"),
  path.join(HOME_DIRECTORY, ".desktop-commander-device"),
  path.join(HOME_DIRECTORY, ".ssh"),
  path.join(HOME_DIRECTORY, ".aws"),
  path.join(HOME_DIRECTORY, ".gnupg"),
  path.join(HOME_DIRECTORY, ".azure"),
  path.join(HOME_DIRECTORY, ".docker"),
  path.join(HOME_DIRECTORY, ".kube"),
  path.join(HOME_DIRECTORY, ".oci"),
  path.join(HOME_DIRECTORY, ".pulumi"),
  path.join(HOME_DIRECTORY, ".terraform.d"),
  path.join(HOME_DIRECTORY, ".netrc"),
  path.join(HOME_DIRECTORY, ".npmrc"),
  path.join(HOME_DIRECTORY, ".pypirc"),
  path.join(HOME_DIRECTORY, ".git-credentials"),
  path.join(HOME_DIRECTORY, ".zsh_history"),
  path.join(HOME_DIRECTORY, ".bash_history"),
  path.join(HOME_DIRECTORY, ".history"),
  path.join(HOME_DIRECTORY, ".local/share/fish/fish_history"),
  path.join(HOME_DIRECTORY, ".local/share/powershell/PSReadLine/ConsoleHost_history.txt"),
  path.join(HOME_DIRECTORY, "Library/Application Support/powershell/PSReadLine/ConsoleHost_history.txt"),
  path.join(HOME_DIRECTORY, "AppData/Roaming/Microsoft/PowerShell/PSReadLine/ConsoleHost_history.txt"),
  path.join(HOME_DIRECTORY, "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),
  path.join(HOME_DIRECTORY, ".vault-token"),
  path.join(HOME_DIRECTORY, ".cargo/credentials"),
  path.join(HOME_DIRECTORY, ".cargo/credentials.toml"),
  path.join(HOME_DIRECTORY, ".config/hub"),
  path.join(HOME_DIRECTORY, ".password-store"),
  path.join(HOME_DIRECTORY, ".local/share/keyrings"),
  path.join(HOME_DIRECTORY, ".zshrc"),
  path.join(HOME_DIRECTORY, ".zshenv"),
  path.join(HOME_DIRECTORY, ".zprofile"),
  path.join(HOME_DIRECTORY, ".zlogin"),
  path.join(HOME_DIRECTORY, ".bashrc"),
  path.join(HOME_DIRECTORY, ".bash_profile"),
  path.join(HOME_DIRECTORY, ".profile"),
  path.join(HOME_DIRECTORY, ".config/fish/config.fish"),
  path.join(HOME_DIRECTORY, ".gitconfig"),
  path.join(HOME_DIRECTORY, ".config/git"),
  path.join(HOME_DIRECTORY, ".config/systemd/user"),
  path.join(HOME_DIRECTORY, ".config/autostart"),
  path.join(HOME_DIRECTORY, ".local/bin"),
  path.join(HOME_DIRECTORY, "Library/Keychains"),
  path.join(HOME_DIRECTORY, "Library/LaunchAgents"),
  path.join(HOME_DIRECTORY, "Library/Safari"),
  path.join(HOME_DIRECTORY, "Library/Application Support/1Password"),
  path.join(HOME_DIRECTORY, "Library/Application Support/Google/Chrome"),
  path.join(HOME_DIRECTORY, "Library/Application Support/Chromium"),
  path.join(HOME_DIRECTORY, "Library/Application Support/BraveSoftware"),
  path.join(HOME_DIRECTORY, "Library/Application Support/Microsoft Edge"),
  path.join(HOME_DIRECTORY, "Library/Application Support/Firefox"),
  path.join(HOME_DIRECTORY, "Library/Application Support/tunnel-client"),
  path.join(HOME_DIRECTORY, ".config/google-chrome"),
  path.join(HOME_DIRECTORY, ".config/chromium"),
  path.join(HOME_DIRECTORY, ".config/BraveSoftware"),
  path.join(HOME_DIRECTORY, ".config/microsoft-edge"),
  path.join(HOME_DIRECTORY, ".mozilla/firefox"),
  path.join(HOME_DIRECTORY, "AppData/Local/Google/Chrome/User Data"),
  path.join(HOME_DIRECTORY, "AppData/Local/Microsoft/Edge/User Data"),
  path.join(HOME_DIRECTORY, "AppData/Roaming/Microsoft/Protect"),
  path.join(HOME_DIRECTORY, "AppData/Roaming/Mozilla/Firefox"),
  path.join(HOME_DIRECTORY, "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"),
  path.join(HOME_DIRECTORY, ".codex"),
  path.join(HOME_DIRECTORY, ".claude"),
  path.join(HOME_DIRECTORY, ".config/tunnel-client"),
  path.join(HOME_DIRECTORY, ".config/gcloud"),
  path.join(HOME_DIRECTORY, ".config/gh"),
  path.join(HOME_DIRECTORY, ".config/glab"),
  path.join(HOME_DIRECTORY, ".config/doctl"),
  path.join(HOME_DIRECTORY, ".config/linode-cli"),
  path.join(HOME_DIRECTORY, ".config/op"),
  path.join(HOME_DIRECTORY, ".config/rclone"),
  path.join(HOME_DIRECTORY, ".config/sops"),
  getFreeRdcCodeRoot(),
] as const;

// These entries are process-wide constants. Resolve their canonical forms
// once so each default denylist check does not repeat one realpath per entry.
const DEFAULT_DENYLIST_COMPARISON_PATHS = new Map<string, readonly string[]>();

export type ContainmentResult =
  | { ok: true; path: string }
  | { ok: false; error: "E_PATH_DENIED" | "E_PATH_ESCAPE" };

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return path.normalize(resolved);
}

function isCaseInsensitive(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

function pathsEqual(first: string, second: string): boolean {
  return isCaseInsensitive()
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

/**
 * Reject roots broad enough to expose a user's entire home directory or an
 * entire filesystem. Callers must also check a root after canonicalization.
 */
export function isUnsafeFilesystemRoot(root: string): boolean {
  if (!path.isAbsolute(root)) return false;

  const homePaths = comparisonPaths(HOME_DIRECTORY);
  return comparisonPaths(root).some((rootPath) => {
    const filesystemRoot = path.parse(rootPath).root;
    if (pathsEqual(rootPath, filesystemRoot)) return true;

    const comparisonRoot = isCaseInsensitive() ? rootPath.toLowerCase() : rootPath;
    const rootPrefix = comparisonRoot.endsWith(path.sep) ? comparisonRoot : `${comparisonRoot}${path.sep}`;
    return homePaths.some((homePath) => {
      if (pathsEqual(rootPath, homePath)) return true;
      const comparisonHome = isCaseInsensitive() ? homePath.toLowerCase() : homePath;
      return comparisonHome.startsWith(rootPrefix);
    });
  });
}

export function containLexical(root: string, candidate: string): ContainmentResult {
  const normRoot = normalize(root);
  const normCand = normalize(candidate);
  const sep = path.sep;

  if (isCaseInsensitive()) {
    const rootLower = normRoot.toLowerCase();
    const candLower = normCand.toLowerCase();

    // Root equality allowed
    if (candLower === rootLower) {
      return { ok: true, path: normCand };
    }
    // Child allowed iff candidate starts with normalizedRoot + path.sep
    const rootPrefix = rootLower.endsWith(sep) ? rootLower : rootLower + sep;
    if (candLower.startsWith(rootPrefix)) {
      return { ok: true, path: normCand };
    }
    // Distinguish escape from boundary: if normalized candidate looks like parent, it's escape
    if (rootLower.startsWith(candLower)) {
      return { ok: false, error: "E_PATH_ESCAPE" };
    }
    return { ok: false, error: "E_PATH_ESCAPE" };
  } else {
    if (normCand === normRoot) {
      return { ok: true, path: normCand };
    }
    const rootPrefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep;
    if (normCand.startsWith(rootPrefix)) {
      return { ok: true, path: normCand };
    }
    if (normRoot.startsWith(normCand)) {
      return { ok: false, error: "E_PATH_ESCAPE" };
    }
    return { ok: false, error: "E_PATH_ESCAPE" };
  }
}

export function containReal(root: string, candidate: string): ContainmentResult {
  // Lexical check first
  const lexical = containLexical(root, candidate);
  if (!lexical.ok) return lexical;

  // Root must resolve to its REAL path
  let realRoot: string;
  try {
    realRoot = normalize(fs.realpathSync(root));
  } catch {
    // If root doesn't exist, can't validate real containment
    return { ok: false, error: "E_PATH_ESCAPE" };
  }

  // Find deepest existing candidate/ancestor INCLUDING candidate itself
  let current = candidate;
  let deepestExisting = "";

  // Check candidate first
  if (fs.existsSync(current)) {
    deepestExisting = current;
  } else {
    // Walk up to find deepest existing ancestor
    current = path.dirname(candidate);
    while (current !== path.dirname(current)) {
      if (fs.existsSync(current)) {
        deepestExisting = current;
        break;
      }
      current = path.dirname(current);
    }
    // If still not found, use root of filesystem
    if (!deepestExisting) {
      deepestExisting = current;
    }
  }

  // Realpath that ancestor
  let realAncestor: string;
  try {
    realAncestor = normalize(fs.realpathSync(deepestExisting));
  } catch {
    return { ok: false, error: "E_PATH_ESCAPE" };
  }

  // Append only the unresolved relative suffix
  const relativeSuffix = path.relative(deepestExisting, candidate);
  const resolvedCandidate = relativeSuffix
    ? path.join(realAncestor, relativeSuffix)
    : realAncestor;

  // Compare against REAL root
  return containLexical(realRoot, resolvedCandidate);
}

function comparisonPaths(candidate: string): readonly string[] {
  const paths = new Set<string>([normalize(candidate)]);
  try {
    paths.add(normalize(fs.realpathSync(candidate)));
  } catch {
    // Non-existent paths are still checked lexically. checkPath() performs a
    // second denylist comparison after resolving the deepest existing ancestor.
  }
  return [...paths];
}

function isDefaultSensitiveHomePath(candidate: string): boolean {
  const normalizedHome = normalize(HOME_DIRECTORY);
  const normalizedCandidate = normalize(candidate);
  const homePrefix = normalizedHome.endsWith(path.sep) ? normalizedHome : `${normalizedHome}${path.sep}`;
  const comparePrefix = isCaseInsensitive() ? homePrefix.toLowerCase() : homePrefix;
  const compareCandidate = isCaseInsensitive() ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  if (!compareCandidate.startsWith(comparePrefix)) return false;

  const segment = compareCandidate.slice(comparePrefix.length).split(path.sep, 1)[0] ?? "";
  return segment === ".codex" || segment.startsWith(".codex-")
    || segment === ".claude" || segment.startsWith(".claude-");
}

function includesDefaultDenylist(denylist: readonly string[]): boolean {
  return denylist === DEFAULT_DENYLIST
    || DEFAULT_DENYLIST.every((defaultEntry) => denylist.includes(defaultEntry));
}

for (const denied of DEFAULT_DENYLIST) {
  DEFAULT_DENYLIST_COMPARISON_PATHS.set(denied, comparisonPaths(denied));
}

export function isDenied(candidate: string, denylist: readonly string[] = DEFAULT_DENYLIST): boolean {
  const candidatePaths = comparisonPaths(candidate);
  const sep = path.sep;

  // Keep the sensitive .codex-* and .claude-* family protections when a
  // caller extends the defaults with additional entries. A genuinely custom
  // denylist remains authoritative and does not inherit default protections.
  if (includesDefaultDenylist(denylist) && candidatePaths.some(isDefaultSensitiveHomePath)) {
    return true;
  }

  for (const denied of denylist) {
    const deniedPaths = DEFAULT_DENYLIST_COMPARISON_PATHS.get(denied) ?? comparisonPaths(denied);
    for (const cand of candidatePaths) {
      for (const deniedPath of deniedPaths) {
        if (isCaseInsensitive()) {
          const lowerCand = cand.toLowerCase();
          const lowerDenied = deniedPath.toLowerCase();
          if (lowerCand === lowerDenied || lowerCand.startsWith(lowerDenied + sep)) return true;
        } else if (cand === deniedPath || cand.startsWith(deniedPath + sep)) {
          return true;
        }
      }
    }
  }
  return false;
}

export function checkPath(
  root: string,
  candidate: string,
  denylist: readonly string[] = DEFAULT_DENYLIST,
): ContainmentResult {
  if (isDenied(candidate, denylist)) {
    return { ok: false, error: "E_PATH_DENIED" };
  }
  const contained = containReal(root, candidate);
  if (!contained.ok) return contained;
  if (isDenied(contained.path, denylist)) {
    return { ok: false, error: "E_PATH_DENIED" };
  }
  return contained;
}
