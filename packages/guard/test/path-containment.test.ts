import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  containLexical,
  containReal,
  isDenied,
  isUnsafeFilesystemRoot,
  getFreeRdcCodeRoot,
  DEFAULT_DENYLIST,
  checkPath,
} from "../src/path-containment.js";

// ============================================================================
// containLexical tests
// ============================================================================

test("path-containment: containLexical accepts same directory", () => {
  const result = containLexical("/app", "/app");
  assert.ok(result.ok);
});

test("path-containment: containLexical accepts subdirectory", () => {
  const result = containLexical("/app", "/app/data");
  assert.ok(result.ok);
});

test("path-containment: containLexical rejects parent traversal", () => {
  const result = containLexical("/app", "/app/../app2");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "E_PATH_ESCAPE");
  }
});

test("path-containment: containLexical rejects .. traversal", () => {
  const result = containLexical("/app", "/app/../../etc");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "E_PATH_ESCAPE");
  }
});

test("path-containment: containLexical rejects absolute re-root", () => {
  const result = containLexical("/app", "/etc/passwd");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "E_PATH_ESCAPE");
  }
});

test("path-containment: containLexical handles trailing separators", () => {
  const result = containLexical("/app/", "/app/data/");
  assert.ok(result.ok);
});

test("path-containment: containLexical prefix-sibling attack defeated", () => {
  const result = containLexical("/app", "/appEvil");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "E_PATH_ESCAPE");
  }
});

test("path-containment: containLexical no double-separator bug", () => {
  // Root without trailing slash should not create /app//data pattern
  const result = containLexical("/app", "/app/data");
  assert.ok(result.ok);
  if (result.ok) {
    // Normalized path should not contain double separators
    assert.ok(!result.path.includes("//"));
  }
});

test("path-containment: containLexical percent-encoded ordinary text", () => {
  // %2e%2e is literal filesystem text "...", not traversal
  const literalPath = "/app/%2e%2e";
  const result = containLexical("/app", literalPath);
  // This should pass lexical check as it's just text
  assert.ok(result.ok);
});

test("path-containment: containLexical decoded traversal rejected", () => {
  // After decoding %2e%2e -> .., this should fail
  const decoded = decodeURIComponent("/app/%2e%2e/etc");
  const result = containLexical("/app", decoded);
  assert.equal(result.ok, false);
});

// ============================================================================
// isDenied tests
// ============================================================================

test("path-containment: isDenied matches exact denylist entry", () => {
  assert.ok(isDenied(path.join(os.homedir(), ".ssh")));
});

test("path-containment: isDenied matches child of denylist entry", () => {
  assert.ok(isDenied(path.join(os.homedir(), ".ssh", "secrets")));
});

test("path-containment: isDenied allows non-denied paths", () => {
  assert.equal(isDenied(path.join(os.homedir(), "documents")), false);
});

test("path-containment: isDenied does not match prefix-sibling", () => {
  assert.equal(isDenied(path.join(os.homedir(), ".ssh-safe")), false);
});

test("path-containment: isDenied boundary with separator", () => {
  // Only exact match or with separator should match
  assert.ok(isDenied(path.join(os.homedir(), ".ssh", "subfolder")));
  assert.equal(isDenied(path.join(os.homedir(), ".sshXXX")), false);
});

test("path-containment: isDenied protects sensitive home directories and families", () => {
  const home = os.homedir();
  const deniedRoots = [
    ".freerdc",
    ".config/tunnel-client",
    ".ssh",
    ".aws",
    ".gnupg",
    ".azure",
    ".docker",
    ".kube",
    ".oci",
    ".config/gcloud",
    ".local/share/keyrings",
    ".password-store",
    ".desktop-commander-device",
    ".codex",
    ".codex-work",
    ".claude",
    ".claude-project",
    "Library/Keychains",
    "Library/Application Support/Google/Chrome",
    ".mozilla/firefox",
  ];

  for (const deniedRoot of deniedRoots) {
    const target = path.join(home, deniedRoot);
    assert.ok(isDenied(target), `expected exact denial: ${target}`);
    assert.ok(isDenied(path.join(target, "secret")), `expected child denial: ${target}`);
  }

  assert.equal(isDenied(path.join(home, ".codexsafe")), false);
  assert.equal(isDenied(path.join(home, ".codex_work")), false);
  assert.equal(isDenied(path.join(home, ".claudesafe")), false);
  assert.equal(isDenied(path.join(home, ".claude_work")), false);
});

test("path-containment: isDenied protects shell, history, credential, and persistence surfaces", () => {
  const home = os.homedir();
  const deniedPaths = [
    ".zsh_history",
    ".bash_history",
    ".history",
    ".local/share/fish/fish_history",
    ".local/share/powershell/PSReadLine/ConsoleHost_history.txt",
    "Library/Application Support/powershell/PSReadLine/ConsoleHost_history.txt",
    "AppData/Roaming/Microsoft/PowerShell/PSReadLine/ConsoleHost_history.txt",
    "AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt",
    ".vault-token",
    ".cargo/credentials",
    ".cargo/credentials.toml",
    ".config/hub",
    "Library/Application Support/tunnel-client",
    ".zshrc",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".bashrc",
    ".bash_profile",
    ".profile",
    ".config/fish/config.fish",
    ".gitconfig",
    ".config/git",
    ".config/systemd/user",
    ".config/autostart",
    "Library/LaunchAgents",
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
    ".local/bin",
  ];

  for (const deniedPath of deniedPaths) {
    const target = path.join(home, deniedPath);
    assert.ok(isDenied(target), `expected exact denial: ${target}`);
    assert.ok(isDenied(path.join(target, "child")), `expected child denial: ${target}`);
    assert.equal(isDenied(`${target}-safe`), false, `expected prefix sibling allowance: ${target}`);
  }
});

test("path-containment: checkPath continues to deny sensitive paths under home", () => {
  const home = os.homedir();
  const historyFile = path.join(home, ".zsh_history");

  assert.deepEqual(checkPath(home, historyFile), { ok: false, error: "E_PATH_DENIED" });
});

test("path-containment: extending defaults retains sensitive home family protection", () => {
  const home = os.homedir();
  const extendedDenylist = [...DEFAULT_DENYLIST, path.join(home, "additional-denied-path")];

  assert.equal(isDenied(path.join(home, ".codex-work", "config"), extendedDenylist), true);
  assert.equal(isDenied(path.join(home, ".claude-project", "config"), extendedDenylist), true);
  assert.equal(isDenied(path.join(home, "additional-denied-path"), extendedDenylist), true);
});

test("path-containment: custom denylist does not inherit default sensitive home families", () => {
  const home = os.homedir();
  const customDenylist = [path.join(home, "only-this-path")];

  assert.equal(isDenied(path.join(home, ".codex-work", "config"), customDenylist), false);
  assert.equal(isDenied(path.join(home, ".claude-project", "config"), customDenylist), false);
  assert.equal(isDenied(path.join(home, "only-this-path", "child"), customDenylist), true);
});

test("path-containment: default denylist protects the complete FreeRDC code root", () => {
  const codeRoot = getFreeRdcCodeRoot();
  assert.ok(DEFAULT_DENYLIST.includes(codeRoot));
  assert.equal(isDenied(codeRoot), true);
  assert.equal(isDenied(path.join(codeRoot, "packages", "guard", "src", "path-containment.ts")), true);
});

test("path-containment: broad filesystem roots are rejected while narrow paths remain eligible", () => {
  const home = os.homedir();
  const filesystemRoot = path.parse(home).root;

  assert.equal(isUnsafeFilesystemRoot(filesystemRoot), true);
  assert.equal(isUnsafeFilesystemRoot(home), true);
  assert.equal(isUnsafeFilesystemRoot(path.join(home, "..")), true);
  assert.equal(isUnsafeFilesystemRoot(path.join(home, "freerdc-work")), false);
  assert.equal(isUnsafeFilesystemRoot(path.join(os.tmpdir(), "freerdc-work")), false);
});

test("path-containment: physical HOME and its ancestors are rejected when HOME is symlinked", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-symlink-home-"));
  const physicalHome = path.join(temporaryDirectory, "physical-home");
  const homeAlias = path.join(temporaryDirectory, "home-alias");
  fs.mkdirSync(physicalHome);
  fs.symlinkSync(physicalHome, homeAlias, "dir");
  const guardModule = new URL("../src/path-containment.js", import.meta.url).href;
  const script = `
    import { isUnsafeFilesystemRoot } from ${JSON.stringify(guardModule)};
    if (!isUnsafeFilesystemRoot(${JSON.stringify(physicalHome)})) process.exit(2);
    if (!isUnsafeFilesystemRoot(${JSON.stringify(temporaryDirectory)})) process.exit(3);
  `;

  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, HOME: homeAlias },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

// ============================================================================
// containReal tests
// ============================================================================

test("path-containment: containReal catches symlink escape", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const outside = path.join(tmpdir, "outside");
    const symlink = path.join(root, "symlink");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "leaked");
    fs.symlinkSync(outside, symlink, "dir");

    // Symlink points outside root
    const result = containReal(root, symlink);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "E_PATH_ESCAPE");
    }
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("path-containment: containReal accepts real subdirectory", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const subdir = path.join(root, "data");
    fs.mkdirSync(subdir, { recursive: true });
    const result = containReal(root, subdir);
    assert.ok(result.ok);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("path-containment: containReal accepts non-existing descendant", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    fs.mkdirSync(root);
    const nonExisting = path.join(root, "future", "file.txt");
    const result = containReal(root, nonExisting);
    assert.ok(result.ok);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("path-containment: containReal rejects child under symlink to outside", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const outside = path.join(tmpdir, "outside");
    const symlink = path.join(root, "link");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, symlink, "dir");

    // Try to access child through symlink
    const childThroughLink = path.join(symlink, "child.txt");
    const result = containReal(root, childThroughLink);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "E_PATH_ESCAPE");
    }
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("path-containment: containReal rejects nested symlink escape", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const outside = path.join(tmpdir, "outside");
    const nested = path.join(root, "nested");
    const symlink = path.join(nested, "link");

    fs.mkdirSync(root);
    fs.mkdirSync(nested);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, symlink, "dir");

    const result = containReal(root, symlink);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "E_PATH_ESCAPE");
    }
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("path-containment: containReal checks candidate itself as existing", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const outside = path.join(tmpdir, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);

    // Create a symlink AT the candidate path itself
    const candidateSymlink = path.join(root, "candidate");
    fs.symlinkSync(outside, candidateSymlink, "dir");

    // Should detect that candidate itself is a symlink to outside
    const result = containReal(root, candidateSymlink);
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

// ============================================================================
// checkPath tests
// ============================================================================

test("path-containment: checkPath rejects denied paths", () => {
  const result = checkPath("/app", path.join(os.homedir(), ".ssh"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "E_PATH_DENIED");
  }
});

test("path-containment: checkPath rejects escaped paths", () => {
  const result = checkPath("/app", "/app/../../../etc");
  assert.equal(result.ok, false);
});

test("path-containment: checkPath denylist before real check", () => {
  // Denied path should return E_PATH_DENIED even before real checks
  const result = checkPath("/tmp", path.join(os.homedir(), ".ssh", "file.txt"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "E_PATH_DENIED");
  }
});


test("path-containment: checkPath re-checks denylist after symlink resolution", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-denied-link-"));
  const root = path.join(tmp, "root");
  const denied = path.join(root, ".blocked");
  const link = path.join(root, "harmless");
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, "secret"), "x");
    fs.symlinkSync(denied, link, "dir");
    const result = checkPath(root, path.join(link, "secret"), [denied]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "E_PATH_DENIED");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("path-containment: checkPath denies a missing target beneath an in-root denied symlink", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-denied-missing-link-"));
  const root = path.join(tmp, "root");
  const denied = path.join(root, ".blocked");
  const link = path.join(root, "harmless");
  try {
    fs.mkdirSync(root);
    fs.mkdirSync(denied);
    fs.symlinkSync(denied, link, "dir");
    const result = checkPath(root, path.join(link, "not-yet-created", "secret"), [denied]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "E_PATH_DENIED");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("path-containment: filesystem-root containment accepts descendants", () => {
  const filesystemRoot = path.parse(process.cwd()).root;
  const child = path.join(filesystemRoot, "tmp");
  const result = containLexical(filesystemRoot, child);
  assert.equal(result.ok, true);
});
