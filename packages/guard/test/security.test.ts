import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { containLexical, containReal, isDenied, checkPath } from "../src/path-containment.js";

test("security:.. traversal defeated", () => {
  const result = containLexical("/app", "/app/../../../etc/passwd");
  assert.equal(result.ok, false);
});

test("security: encoded separators as literal filename text", () => {
  // Percent-encoded separators are literal filename characters at filesystem boundary
  const result = containLexical("/app", "/app/%2F..%2F..%2Fetc");
  assert.equal(result.ok, true, "literal encoded path should be contained");

  // After URL-decoding, traversal should be rejected
  const decoded = decodeURIComponent("/app/%2F..%2F..%2Fetc");
  const decodedResult = containLexical("/app", decoded);
  assert.equal(decodedResult.ok, false, "decoded traversal should be rejected");
});

test("security: double separators defeated", () => {
  const result = containLexical("/app", "/app//..//..//etc");
  assert.equal(result.ok, false);
});

test("security: symlink pointing outside root caught", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const outside = path.join(tmpdir, "outside");
    const symlink = path.join(root, "link");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "x"), "y");
    fs.symlinkSync(outside, symlink, "dir");
    const result = containReal(root, symlink);
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("security: symlink chain escaped caught", () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "freerdc-test-"));
  try {
    const root = path.join(tmpdir, "root");
    const outer = path.join(tmpdir, "outer");
    const inner = path.join(outer, "inner");
    const link1 = path.join(root, "link1");
    const link2 = path.join(root, "link2");
    fs.mkdirSync(root);
    fs.mkdirSync(inner, { recursive: true });
    fs.symlinkSync(outer, link1, "dir");
    fs.symlinkSync(inner, link2, "dir");
    // link1/link2 points outside root
    const result = containReal(root, path.join(link1, "link2"));
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test("security: prefix-sibling directory defeated", () => {
  const result = containLexical("/app", "/appEvil/data");
  assert.equal(result.ok, false);
});

test("security: absolute path injection defeated", () => {
  const result = containLexical("/app", "/etc/passwd");
  assert.equal(result.ok, false);
});

test("security: denylist exact protected directory hit", () => {
  assert.ok(isDenied(path.join(os.homedir(), ".ssh")));
});

test("security: denylist child of denied root hit", () => {
  assert.ok(isDenied(path.join(os.homedir(), ".ssh", "secrets")));
});

test("security: new denylist entries reject exact and child paths", () => {
  const home = os.homedir();
  const deniedRoots = [
    path.join(home, ".gnupg"),
    path.join(home, "Library/Application Support/Google/Chrome"),
    path.join(home, ".config/tunnel-client"),
  ];

  for (const deniedRoot of deniedRoots) {
    assert.equal(isDenied(deniedRoot), true, `expected exact denial: ${deniedRoot}`);
    assert.equal(
      isDenied(path.join(deniedRoot, "test-child")),
      true,
      `expected child denial: ${deniedRoot}`,
    );
  }
});

test("security: new denylist entries allow prefix siblings", () => {
  const home = os.homedir();
  const deniedRoots = [
    path.join(home, ".gnupg"),
    path.join(home, "Library/Application Support/Google/Chrome"),
    path.join(home, ".config/tunnel-client"),
  ];

  for (const deniedRoot of deniedRoots) {
    assert.equal(
      isDenied(`${deniedRoot}-safe`),
      false,
      `expected prefix sibling allowance: ${deniedRoot}`,
    );
  }
});

test("security: shell histories and persistence paths reject exact and child paths", () => {
  const home = os.homedir();
  const deniedPaths = [
    ".zsh_history",
    ".zshenv",
    ".zprofile",
    ".zlogin",
    ".local/share/fish/fish_history",
    ".config/fish/config.fish",
    ".cargo/credentials.toml",
    ".gitconfig",
    ".config/git",
    ".config/systemd/user",
    ".config/autostart",
    "Library/Application Support/tunnel-client",
    "Library/LaunchAgents",
    "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
  ];

  for (const deniedPath of deniedPaths) {
    const target = path.join(home, deniedPath);
    assert.equal(isDenied(target), true, `expected exact denial: ${target}`);
    assert.equal(isDenied(path.join(target, "child")), true, `expected child denial: ${target}`);
  }
});

test("security: trailing-separator variant defeated", () => {
  const result = containLexical("/app/", "/app/../../../etc");
  assert.equal(result.ok, false);
});

test("security: checkPath with denylist path", () => {
  const result = checkPath("/app", path.join(os.homedir(), ".ssh"));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.strictEqual(result.error, "E_PATH_DENIED");
  }
});
