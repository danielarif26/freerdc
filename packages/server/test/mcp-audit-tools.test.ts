import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { ProcessManager, SafeFilesystem, type CommandPolicy } from "@freerdc/agent";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { E_INTERNAL, E_PATH_ESCAPE } from "@freerdc/protocol";
import { HashChainAuditLog, LoopbackMcpHttpHost, createFreeRdcMcpServer } from "../src/index.js";

const NODE = realpathSync(process.execPath);
const NODE_BASENAME = basename(NODE);
const FILESYSTEM_TOOLS = [
  "fs_delete", "fs_list", "fs_mkdir", "fs_move", "fs_read", "fs_search", "fs_stat", "fs_write",
];

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function allowNode(): CommandPolicy {
  return { rules: [{ executable: NODE, basename: NODE_BASENAME, argv: (argv) => argv[0] === "-e" }] };
}

function payload(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  const item = result.content[0];
  assert.equal(item?.type, "text");
  return JSON.parse(item.text) as Record<string, unknown>;
}

function errorPayload(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  const item = result.content[0];
  assert.equal(item?.type, "text");
  return JSON.parse(item.text) as Record<string, unknown>;
}

function auditRecords(result: ToolResult): Array<Record<string, unknown>> {
  const records = payload(result).records;
  assert.ok(Array.isArray(records));
  return records as Array<Record<string, unknown>>;
}

async function withClient(
  filesystem: SafeFilesystem,
  auditLog: HashChainAuditLog | undefined,
  processManager: ProcessManager | undefined,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const host = new LoopbackMcpHttpHost(
    () => createFreeRdcMcpServer({ filesystem, auditLog, processManager }),
    0,
  );
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const address = await host.start();
    client = new Client({ name: "freerdc-mcp-audit-e2e", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
    transport = new StreamableHTTPClientTransport(new URL(`http://${address.host}:${address.port}/mcp`));
    await client.connect(transport);
    await body(client);
  } finally {
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await host.close();
  }
}

async function withTemporaryAuditRoot(
  name: string,
  body: (root: string, auditLog: HashChainAuditLog, manager: ProcessManager) => Promise<void>,
): Promise<void> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-mcp-audit-${name}-`)));
  const root = join(directory, "root");
  mkdirSync(root);
  const auditLog = new HashChainAuditLog(join(directory, "audit.jsonl"));
  const manager = new ProcessManager({ roots: [root], policy: allowNode() });
  try {
    await body(root, auditLog, manager);
  } finally {
    manager.killAll(true);
    auditLog.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("audit_tail is exposed only when an audit log is supplied and its schema caps limit at 100", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "freerdc-mcp-audit-tools-")));
  const root = join(directory, "root");
  mkdirSync(root);
  try {
    const filesystem = new SafeFilesystem({ roots: [root] });
    await withClient(filesystem, undefined, undefined, async (client) => {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), FILESYSTEM_TOOLS);
    });

    const auditLog = new HashChainAuditLog(join(directory, "audit.jsonl"));
    try {
      await withClient(filesystem, auditLog, undefined, async (client) => {
        const { tools } = await client.listTools();
        const auditTail = tools.find((tool) => tool.name === "audit_tail");
        assert.ok(auditTail);
        assert.equal((auditTail.inputSchema as { properties?: { limit?: { maximum?: unknown } } }).properties?.limit?.maximum, 100);
        assert.equal((await client.callTool({ name: "audit_tail", arguments: { limit: 101 } })).isError, true);
      });
    } finally {
      auditLog.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("read-only and mutation tools append safe successful audit records", async () => {
  await withTemporaryAuditRoot("success", async (root, auditLog, manager) => {
    const source = join(root, "source.txt");
    const secret = "never-audit-file-contents";
    await withClient(new SafeFilesystem({ roots: [root] }), auditLog, manager, async (client) => {
      payload(await client.callTool({ name: "fs_write", arguments: { path: source, text: secret, dryRun: "off" } }));
      payload(await client.callTool({ name: "fs_read", arguments: { path: source } }));
      const records = auditRecords(await client.callTool({ name: "audit_tail", arguments: { limit: 100 } }));
      assert.deepEqual(records.map(({ action, outcome, dryRun }) => ({ action, outcome, dryRun })), [
        { action: "fs_write", outcome: "started", dryRun: false },
        { action: "fs_write", outcome: "succeeded", dryRun: false },
        { action: "fs_read", outcome: "started", dryRun: false },
        { action: "fs_read", outcome: "succeeded", dryRun: false },
      ]);
      for (const record of records) {
        assert.deepEqual(Object.keys(record).sort(), ["action", "dryRun", "hash", "outcome", "prevHash", "resource", "seq", "timestamp"]);
      }
      assert.doesNotMatch(JSON.stringify(records), new RegExp(secret));
    });
  });
});

test("dry-run mutation is audited as planned and has no filesystem side effect", async () => {
  await withTemporaryAuditRoot("dry-run", async (root, auditLog, manager) => {
    const target = join(root, "not-created.txt");
    await withClient(new SafeFilesystem({ roots: [root] }), auditLog, manager, async (client) => {
      assert.equal(payload(await client.callTool({ name: "fs_write", arguments: {
        path: target, text: "planned-content", dryRun: "plan",
      } })).planned, true);
      assert.equal(existsSync(target), false);
      const records = auditRecords(await client.callTool({ name: "audit_tail", arguments: {} }));
      assert.deepEqual(records.map(({ action, outcome, dryRun }) => ({ action, outcome, dryRun })), [
        { action: "fs_write", outcome: "planned", dryRun: true },
      ]);
    });
  });
});

test("failed FreeRdcError audit uses its canonical code without raw input", async () => {
  await withTemporaryAuditRoot("failure", async (root, auditLog, manager) => {
    const rawInput = "raw-audit-input-must-not-appear";
    await withClient(new SafeFilesystem({ roots: [root] }), auditLog, manager, async (client) => {
      const result = await client.callTool({ name: "fs_stat", arguments: { path: `/not-allowed/${rawInput}` } });
      assert.deepEqual(errorPayload(result), { code: E_PATH_ESCAPE, message: E_PATH_ESCAPE });
      const records = auditRecords(await client.callTool({ name: "audit_tail", arguments: {} }));
      assert.deepEqual(records.map(({ action, outcome, errorCode }) => ({ action, outcome, errorCode })), [
        { action: "fs_stat", outcome: "started", errorCode: undefined },
        { action: "fs_stat", outcome: "failed", errorCode: E_PATH_ESCAPE },
      ]);
      assert.doesNotMatch(JSON.stringify(records), new RegExp(rawInput));
    });
  });
});

test("process audit records and audit_tail never expose argv, terminal input, or environment values", async () => {
  await withTemporaryAuditRoot("process-secrets", async (root, auditLog, manager) => {
    const argvSecret = "argv-secret-value";
    const inputSecret = "terminal-input-secret-value";
    const environmentSecret = "environment-secret-value";
    await withClient(new SafeFilesystem({ roots: [root] }), auditLog, manager, async (client) => {
      const started = payload(await client.callTool({ name: "terminal_start", arguments: {
        executable: NODE,
        argv: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)", argvSecret, environmentSecret],
        dryRun: "off",
      } }));
      await client.callTool({ name: "terminal_input", arguments: { id: started.id, text: inputSecret } });
      const firstTail = auditRecords(await client.callTool({ name: "audit_tail", arguments: {} }));
      const secondTail = auditRecords(await client.callTool({ name: "audit_tail", arguments: {} }));
      assert.deepEqual(secondTail, firstTail);
      assert.equal(firstTail.some((record) => record.action === "audit_tail"), false);
      const serialized = JSON.stringify(firstTail);
      for (const secret of [argvSecret, inputSecret, environmentSecret]) assert.doesNotMatch(serialized, new RegExp(secret));
      assert.equal(manager.list().length, 1);
    });
  });
});

test("a closed audit log fails closed before filesystem and process side effects", async () => {
  await withTemporaryAuditRoot("fail-closed", async (root, auditLog, manager) => {
    const target = join(root, "must-not-exist.txt");
    auditLog.close();
    await withClient(new SafeFilesystem({ roots: [root] }), auditLog, manager, async (client) => {
      assert.deepEqual(errorPayload(await client.callTool({ name: "fs_write", arguments: {
        path: target, text: "must-not-write", dryRun: "off",
      } })), { code: E_INTERNAL, message: E_INTERNAL });
      assert.equal(existsSync(target), false);

      assert.deepEqual(errorPayload(await client.callTool({ name: "terminal_start", arguments: {
        executable: NODE, argv: ["-e", "setInterval(() => {}, 1000)"], dryRun: "off",
      } })), { code: E_INTERNAL, message: E_INTERNAL });
      assert.equal(manager.list().length, 0);
    });
  });
});
