import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SafeFilesystem } from "@freerdc/agent";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { E_INTERNAL, E_PATH_DENIED, E_TOO_LARGE, FreeRdcError } from "@freerdc/protocol";
import { createFreeRdcMcpServer, createMcpHttpHost } from "../src/index.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

async function withClient(
  filesystem: SafeFilesystem,
  body: (client: Client) => Promise<void>,
  maxToolOutputBytes?: number,
): Promise<void> {
  const host = createMcpHttpHost(
    () => createFreeRdcMcpServer({ filesystem, maxToolOutputBytes }),
    0,
  );
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const { host: address, port } = await host.start();
    client = new Client(
      { name: "freerdc-mcp-e2e-test", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    transport = new StreamableHTTPClientTransport(new URL(`http://${address}:${port}/mcp`));
    await client.connect(transport);
    await body(client);
  } finally {
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await host.close();
  }
}

function withTemporaryRoot(name: string, body: (root: string) => Promise<void>): Promise<void> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), `freerdc-mcp-${name}-`)));
  const root = join(directory, "root");
  mkdirSync(root);
  return body(root).finally(() => {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
}

test("connects with automatic version negotiation and lists only filesystem tools", async () => {
  await withTemporaryRoot("connect", async (root) => {
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      assert.ok(client.getNegotiatedProtocolVersion());
      assert.equal(client.getProtocolEra(), "modern");
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "fs_delete", "fs_list", "fs_mkdir", "fs_move", "fs_read", "fs_search", "fs_stat", "fs_write",
      ]);
    });
  });
});

test("runs mkdir, write, read, stat, search, move, and delete through MCP", async () => {
  await withTemporaryRoot("flow", async (root) => {
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const directory = join(root, "notes");
      const source = join(directory, "source.txt");
      const destination = join(directory, "moved.txt");
      assert.deepEqual(payload(await client.callTool({ name: "fs_mkdir", arguments: { path: directory, dryRun: "off" } })), {
        operation: "mkdir", path: directory, planned: false,
      });
      assert.deepEqual(payload(await client.callTool({ name: "fs_write", arguments: { path: source, text: "needle needle", dryRun: "off" } })), {
        operation: "write", path: source, planned: false,
      });
      assert.deepEqual(payload(await client.callTool({ name: "fs_read", arguments: { path: source } })), {
        path: source, encoding: "utf8", data: "needle needle",
      });
      const stat = payload(await client.callTool({ name: "fs_stat", arguments: { path: source } }));
      assert.equal(stat.path, source);
      assert.equal(stat.type, "file");
      assert.equal(stat.size, Buffer.byteLength("needle needle"));
      assert.deepEqual(payload(await client.callTool({ name: "fs_search", arguments: { path: root, query: "needle" } })), {
        matches: [{ path: source, matchCount: 2 }], truncated: false,
      });
      assert.deepEqual(payload(await client.callTool({ name: "fs_move", arguments: {
        source, destination, expectedSha256: sha256("needle needle"), dryRun: "off",
      } })), { operation: "moveFile", path: destination, source, destination, planned: false });
      assert.deepEqual(payload(await client.callTool({ name: "fs_delete", arguments: {
        path: destination, expectedSha256: sha256("needle needle"), dryRun: "off",
      } })), { operation: "deleteFile", path: destination, planned: false });
      assert.equal(existsSync(destination), false);
    });
  });
});

test("dry-run mutations have no filesystem side effects", async () => {
  await withTemporaryRoot("dry-run", async (root) => {
    const source = join(root, "source.txt");
    writeFileSync(source, "original");
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const directory = join(root, "planned-directory");
      const newFile = join(root, "planned-write.txt");
      const moved = join(root, "planned-move.txt");
      assert.equal(payload(await client.callTool({ name: "fs_mkdir", arguments: { path: directory, dryRun: "plan" } })).planned, true);
      assert.equal(payload(await client.callTool({ name: "fs_write", arguments: { path: newFile, text: "planned", dryRun: "plan" } })).planned, true);
      assert.equal(payload(await client.callTool({ name: "fs_move", arguments: {
        source, destination: moved, expectedSha256: sha256("original"), dryRun: "plan",
      } })).planned, true);
      assert.equal(payload(await client.callTool({ name: "fs_delete", arguments: {
        path: source, expectedSha256: sha256("original"), dryRun: "plan",
      } })).planned, true);
      assert.equal(existsSync(directory), false);
      assert.equal(existsSync(newFile), false);
      assert.equal(existsSync(moved), false);
      assert.equal(readFileSync(source, "utf8"), "original");
    });
  });
});

test("round-trips base64 data through fs_write and fs_read", async () => {
  await withTemporaryRoot("base64", async (root) => {
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const file = join(root, "binary.bin");
      const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
      payload(await client.callTool({ name: "fs_write", arguments: { path: file, base64: bytes.toString("base64"), dryRun: "off" } }));
      assert.deepEqual(payload(await client.callTool({ name: "fs_read", arguments: { path: file, encoding: "base64" } })), {
        path: file, encoding: "base64", data: bytes.toString("base64"),
      });
    });
  });
});

test("rejects malformed or non-canonical base64 writes without creating files", async () => {
  await withTemporaryRoot("invalid-base64", async (root) => {
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const invalidBase64 = ["!!!!", "Zg=", "Zg==\n", "_w=="];

      for (const [index, base64] of invalidBase64.entries()) {
        const file = join(root, `invalid-${index}.bin`);
        const result = await client.callTool({
          name: "fs_write",
          arguments: { path: file, base64, dryRun: "off" },
        });
        assert.equal(result.isError, true, `expected ${JSON.stringify(base64)} to be rejected`);
        assert.equal(existsSync(file), false, `write created ${file} for ${JSON.stringify(base64)}`);
      }
    });
  });
});

test("returns canonical FreeRdcError content and sanitizes unknown errors", async () => {
  await withTemporaryRoot("errors", async (root) => {
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const denied = errorPayload(await client.callTool({ name: "fs_stat", arguments: { path: join(homedir(), ".ssh", "secret") } }));
      assert.deepEqual(denied, { code: E_PATH_DENIED, message: E_PATH_DENIED });
    });
  });

  const fakeFilesystem = { stat: () => { throw new Error("raw-secret-message"); } } as unknown as SafeFilesystem;
  await withClient(fakeFilesystem, async (client) => {
    const internal = errorPayload(await client.callTool({ name: "fs_stat", arguments: { path: "/safe" } }));
    assert.deepEqual(internal, { code: E_INTERNAL, message: E_INTERNAL });
    assert.doesNotMatch(JSON.stringify(internal), /raw-secret-message/);
  });
});

test("limits serialized MCP tool output and rejects invalid tool schemas", async () => {
  await withTemporaryRoot("limits", async (root) => {
    const file = join(root, "large.txt");
    writeFileSync(file, "this response is deliberately larger than the configured cap");
    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const tooLarge = errorPayload(await client.callTool({ name: "fs_read", arguments: { path: file } }));
      assert.deepEqual(tooLarge, { code: E_TOO_LARGE, message: E_TOO_LARGE });
    }, 8);

    await withClient(new SafeFilesystem({ roots: [root] }), async (client) => {
      const assertSchemaRejection = async (name: string, args: Record<string, unknown>): Promise<void> => {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true);
      };
      await assertSchemaRejection("fs_delete", { path: file, dryRun: "off" });
      await assertSchemaRejection("fs_move", { source: file, destination: join(root, "other"), dryRun: "off" });
      await assertSchemaRejection("fs_write", { path: join(root, "both"), text: "x", base64: "eA==", dryRun: "off" });
      await assertSchemaRejection("fs_write", { path: join(root, "neither"), dryRun: "off" });
    });
  });
});
