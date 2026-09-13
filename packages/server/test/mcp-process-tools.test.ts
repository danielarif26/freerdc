import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { ProcessManager, SafeFilesystem, type CommandPolicy, type CommandRule } from "@freerdc/agent";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { E_DEVICE_OFFLINE, E_TOO_LARGE } from "@freerdc/protocol";
import { LoopbackMcpHttpHost, createFreeRdcMcpServer } from "../src/index.js";

const NODE = realpathSync(process.execPath);
const NODE_BASENAME = basename(NODE);
const FILESYSTEM_TOOLS = [
  "fs_delete", "fs_list", "fs_mkdir", "fs_move", "fs_read", "fs_search", "fs_stat", "fs_write",
];
const PROCESS_TOOLS = [
  "process_kill", "process_list", "terminal_input", "terminal_kill", "terminal_list", "terminal_read", "terminal_start",
];

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function allowNode(argv: CommandRule["argv"] = (args) => args[0] === "-e"): CommandPolicy {
  return { rules: [{ executable: NODE, basename: NODE_BASENAME, argv }] };
}

function resultPayload(result: ToolResult): Record<string, unknown> {
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

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function withMcpClient(
  filesystem: SafeFilesystem,
  processManager: ProcessManager | undefined,
  body: (client: Client) => Promise<void>,
  maxToolOutputBytes?: number,
): Promise<void> {
  const host = new LoopbackMcpHttpHost(
    () => createFreeRdcMcpServer({ filesystem, processManager, maxToolOutputBytes }),
    0,
  );
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const address = await host.start();
    client = new Client({ name: "freerdc-process-e2e", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
    transport = new StreamableHTTPClientTransport(new URL(`http://${address.host}:${address.port}/mcp`));
    await client.connect(transport);
    await body(client);
  } finally {
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await host.close();
  }
}

async function withTemporaryRoot(
  name: string,
  limits: ConstructorParameters<typeof ProcessManager>[0]["limits"] | undefined,
  body: (client: Client, manager: ProcessManager, root: string) => Promise<void>,
  maxToolOutputBytes?: number,
): Promise<void> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-mcp-process-${name}-`)));
  const root = join(directory, "root");
  mkdirSync(root);
  const manager = new ProcessManager({ roots: [root], policy: allowNode(), limits });
  try {
    await withMcpClient(new SafeFilesystem({ roots: [root] }), manager, (client) => body(client, manager, root), maxToolOutputBytes);
  } finally {
    manager.killAll(true);
    await waitFor(() => manager.list().every((process) => process.status === "exited"), "owned child cleanup did not finish");
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("MCP v2 exposes only filesystem tools without a process manager", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "freerdc-mcp-process-no-manager-")));
  try {
    const root = join(directory, "root");
    mkdirSync(root);
    await withMcpClient(new SafeFilesystem({ roots: [root] }), undefined, async (client) => {
      assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), FILESYSTEM_TOOLS);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("MCP v2 starts an argv-only Node child and exposes sanitized process summaries", async () => {
  await withTemporaryRoot("start-list", undefined, async (client, manager) => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, [...FILESYSTEM_TOOLS, ...PROCESS_TOOLS].sort());

    const started = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "setInterval(() => {}, 1000)", "private-argv"], dryRun: "off",
    } }));
    assert.deepEqual(Object.keys(started).sort(), ["id", "startedAt", "status"]);
    const id = started.id as string;
    assert.match(id, /^[0-9a-f-]{36}$/);

    for (const name of ["terminal_list", "process_list"]) {
      const listed = resultPayload(await client.callTool({ name, arguments: {} }));
      const processes = listed.processes as Array<Record<string, unknown>>;
      assert.equal(processes.length, 1);
      assert.deepEqual(Object.keys(processes[0] ?? {}).sort(), ["id", "startedAt", "status"]);
      assert.doesNotMatch(JSON.stringify(listed), /private-argv|pid|argv|env/i);
    }
    assert.equal(manager.list().length, 1);
  });
});

test("terminal input round-trips and terminal read returns output and status", async () => {
  await withTemporaryRoot("input", undefined, async (client, manager) => {
    const started = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "process.stdin.once('data', data => { process.stdout.write(data); process.exit(0); })"], dryRun: "off",
    } }));
    const id = started.id as string;
    assert.deepEqual(resultPayload(await client.callTool({ name: "terminal_input", arguments: { id, text: "roundtrip" } })), { id, accepted: true });
    await waitFor(
      () => manager.list().some((process) => process.id === id && process.status === "exited"),
      "stdin child did not exit",
    );
    const read = resultPayload(await client.callTool({ name: "terminal_read", arguments: { id } }));
    assert.equal(read.stdout, "roundtrip");
    assert.equal(read.status, "exited");
    assert.equal(read.truncated, false);
    assert.equal(read.hasMore, false);
  });
});

test("kill tools accept only owned opaque IDs and return safe offline errors", async () => {
  await withTemporaryRoot("kill", undefined, async (client) => {
    for (const name of ["terminal_kill", "process_kill"]) {
      const unknown = errorPayload(await client.callTool({ name, arguments: { id: "not-an-owned-id" } }));
      assert.deepEqual(unknown, { code: E_DEVICE_OFFLINE, message: E_DEVICE_OFFLINE });
    }
    const started = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "setInterval(() => {}, 1000)"], dryRun: "off",
    } }));
    const id = started.id as string;
    assert.deepEqual(resultPayload(await client.callTool({ name: "process_kill", arguments: { id, force: true } })), { id, killed: true });
  });
});

test("dry-run starts no process and has no child side effect", async () => {
  await withTemporaryRoot("dry-run", undefined, async (client, manager, root) => {
    const marker = join(root, "must-not-exist");
    assert.deepEqual(resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE,
      argv: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
      dryRun: "plan",
    } })), { planned: true });
    assert.equal(manager.list().length, 0);
    assert.equal(existsSync(marker), false);
  });
});

test("process input validation, caps, and errors stay safe at the MCP boundary", async () => {
  await withTemporaryRoot("limits", { maxWriteBytes: 3, maxOutputBytes: 16 }, async (client) => {
    const started = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], dryRun: "off",
    } }));
    const id = started.id as string;

    for (const base64 of ["!!!!", "Zg=", "Zg==\n", "_w=="]) {
      const rejected = await client.callTool({ name: "terminal_input", arguments: { id, base64 } });
      assert.equal(rejected.isError, true);
    }
    const oversized = errorPayload(await client.callTool({ name: "terminal_input", arguments: { id, text: "four" } }));
    assert.deepEqual(oversized, { code: E_TOO_LARGE, message: E_TOO_LARGE });

    const output = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "process.stdout.write('x'.repeat(512)); setInterval(() => {}, 1000)"], dryRun: "off",
    } }));
    const outputId = output.id as string;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const read = resultPayload(await client.callTool({ name: "terminal_read", arguments: { id: outputId } }));
    assert.equal(read.truncated, true);
    assert.ok(Buffer.byteLength(read.stdout as string, "utf8") <= 16);

    const secret = "raw-secret-value";
    const denied = errorPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: "/not-a-real-executable", argv: ["-e", secret], dryRun: "off",
    } }));
    assert.doesNotMatch(JSON.stringify(denied), /raw-secret-value|stack|\/not-a-real-executable/i);
  });
});


test("terminal_read preserves output across response-size chunks", async () => {
  await withTemporaryRoot("chunked-read", { maxOutputBytes: 4096 }, async (client, manager) => {
    const started = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "process.stdout.write('z'.repeat(2000))"], dryRun: "off",
    } }));
    const id = started.id as string;
    await waitFor(() => manager.list().some((process) => process.id === id && process.status === "exited"), "chunk child did not exit");
    let combined = "";
    for (;;) {
      const read = resultPayload(await client.callTool({ name: "terminal_read", arguments: { id } }));
      combined += read.stdout as string;
      if (read.hasMore === false) break;
    }
    assert.equal(combined, "z".repeat(2000));
  }, 1024);
});

test("terminal_read retries a smaller non-destructive peek when JSON escaping exceeds the cap", async () => {
  await withTemporaryRoot("escaped-chunked-read", { maxOutputBytes: 4096 }, async (client, manager) => {
    const started = resultPayload(await client.callTool({ name: "terminal_start", arguments: {
      executable: NODE, argv: ["-e", "process.stdout.write(Buffer.alloc(600, 1))"], dryRun: "off",
    } }));
    const id = started.id as string;
    await waitFor(() => manager.list().some((process) => process.id === id && process.status === "exited"), "escaped chunk child did not exit");
    const chunks: Buffer[] = [];
    for (;;) {
      const read = resultPayload(await client.callTool({ name: "terminal_read", arguments: { id } }));
      assert.ok(Buffer.byteLength(JSON.stringify(read), "utf8") <= 512);
      chunks.push(Buffer.from(read.stdout as string, "utf8"));
      if (read.hasMore === false) break;
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(600, 1));
  }, 512);
});

test("process-enabled MCP rejects an output cap too small to make progress, while management-only remains valid", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "freerdc-mcp-process-cap-")));
  const root = join(directory, "root");
  mkdirSync(root);
  const filesystem = new SafeFilesystem({ roots: [root] });
  const manager = new ProcessManager({ roots: [root], policy: allowNode() });
  try {
    assert.doesNotThrow(() => createFreeRdcMcpServer({ filesystem, maxToolOutputBytes: 1 }));
    assert.throws(
      () => createFreeRdcMcpServer({ filesystem, processManager: manager, maxToolOutputBytes: 166 }),
      /too small for process tools/,
    );
    assert.doesNotThrow(
      () => createFreeRdcMcpServer({ filesystem, processManager: manager, maxToolOutputBytes: 167 }),
    );
  } finally {
    manager.killAll(true);
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
