import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { SafeFilesystem } from "@freerdc/agent";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { E_INTERNAL, E_TOO_LARGE } from "@freerdc/protocol";
import {
  createFreeRdcMcpServer,
  createMcpHttpHost,
  DeviceRegistry,
  HashChainAuditLog,
  type CreateFreeRdcMcpServerOptions,
} from "../src/index.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

const MANAGEMENT_TOOLS = ["device_list", "policy_describe", "system_health"];
const HEALTH = {
  version: "1.2.3",
  healthy: true,
  killSwitchActive: false,
  filesystemEnabled: true,
  processEnabled: false,
  auditEnabled: true,
  deviceCount: 2,
  onlineDeviceCount: 1,
  processCount: 0,
  capabilities: ["filesystem", "device", "filesystem"],
};
const POLICY = {
  commandRuleCount: 3,
  limits: {
    maxReadBytes: 10,
    maxWriteBytes: 20,
    maxSearchBytes: 30,
    maxOutputBytes: 40,
    maxSearchResults: 50,
    commandTimeoutMs: 60,
    maxFilesystemConcurrency: 2,
    maxCommandConcurrency: 3,
  },
  capabilities: ["process", "filesystem", "process"],
};

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
  options: Omit<CreateFreeRdcMcpServerOptions, "filesystem">,
  body: (client: Client) => Promise<void>,
): Promise<void> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "freerdc-mcp-management-")));
  const root = join(directory, "root");
  mkdirSync(root);
  const host = createMcpHttpHost(
    () => createFreeRdcMcpServer({ filesystem: new SafeFilesystem({ roots: [root] }), ...options }),
    0,
  );
  let client: Client | undefined;
  let transport: StreamableHTTPClientTransport | undefined;
  try {
    const { host: address, port } = await host.start();
    client = new Client({ name: "freerdc-mcp-management-e2e", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
    transport = new StreamableHTTPClientTransport(new URL(`http://${address}:${port}/mcp`));
    await client.connect(transport);
    await body(client);
  } finally {
    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await host.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

function toolNames(client: Client): Promise<string[]> {
  return client.listTools().then(({ tools }) => tools.map((tool) => tool.name).sort());
}

test("management tools are absent when their providers are omitted", async () => {
  await withClient({}, async (client) => {
    const names = await toolNames(client);
    for (const name of MANAGEMENT_TOOLS) assert.equal(names.includes(name), false);
  });
});

test("device_list returns sorted, safe DeviceRegistry records only", async () => {
  const registry = new DeviceRegistry(() => new Date("2026-09-10T12:00:00.000Z"));
  registry.register({ id: "z-device", displayName: "Z device", capabilities: ["video", "audio", "video"] });
  registry.register({ id: "a-device", capabilities: ["filesystem"] });
  registry.markOffline("z-device");

  await withClient({ deviceRegistry: registry }, async (client) => {
    const result = payload(await client.callTool({ name: "device_list", arguments: {} }));
    assert.deepEqual(result, {
      devices: [
        {
          id: "a-device", capabilities: ["filesystem"], status: "online",
          registeredAt: "2026-09-10T12:00:00.000Z", lastSeenAt: "2026-09-10T12:00:00.000Z",
        },
        {
          id: "z-device", displayName: "Z device", capabilities: ["audio", "video"], status: "offline",
          registeredAt: "2026-09-10T12:00:00.000Z", lastSeenAt: "2026-09-10T12:00:00.000Z",
        },
      ],
    });
    for (const device of result.devices as Array<Record<string, unknown>>) {
      assert.deepEqual(Object.keys(device).sort(), ["capabilities", "displayName", "id", "lastSeenAt", "registeredAt", "status"].filter((key) => key !== "displayName" || "displayName" in device));
      assert.doesNotMatch(JSON.stringify(device), /metadata|secret|path/i);
    }
  });
});

test("system_health and policy_describe expose only frozen normalized contracts", async () => {
  await withClient({ systemHealth: () => HEALTH, policyDescription: POLICY }, async (client) => {
    assert.deepEqual(payload(await client.callTool({ name: "system_health", arguments: {} })), {
      ...HEALTH, capabilities: ["device", "filesystem"],
    });
    assert.deepEqual(payload(await client.callTool({ name: "policy_describe", arguments: {} })), {
      ...POLICY, capabilities: ["filesystem", "process"],
    });
  });
});

test("malformed management providers fail closed without echoing provider secrets", async () => {
  const secret = "management-provider-secret-/private/path";
  const invalidHealth = [
    { ...HEALTH, extra: secret },
    { ...HEALTH, version: 1 },
    { ...HEALTH, healthy: "true" },
    { ...HEALTH, deviceCount: -1 },
    { ...HEALTH, onlineDeviceCount: 1.5 },
  ];
  for (const value of invalidHealth) {
    await withClient({ systemHealth: () => value as typeof HEALTH }, async (client) => {
      const result = await client.callTool({ name: "system_health", arguments: {} });
      assert.deepEqual(errorPayload(result), { code: E_INTERNAL, message: E_INTERNAL });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    });
  }

  const invalidPolicies = [
    { ...POLICY, extra: secret },
    { ...POLICY, commandRuleCount: -1 },
    { ...POLICY, limits: { ...POLICY.limits, maxReadBytes: 1.5 } },
    { ...POLICY, limits: { ...POLICY.limits, maxWriteBytes: secret } },
    { ...POLICY, limits: { ...POLICY.limits, extra: secret } },
  ];
  for (const value of invalidPolicies) {
    await withClient({ policyDescription: value as typeof POLICY }, async (client) => {
      const result = await client.callTool({ name: "policy_describe", arguments: {} });
      assert.deepEqual(errorPayload(result), { code: E_INTERNAL, message: E_INTERNAL });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    });
  }
});

test("management provider strings reject unsafe or excessive values", async () => {
  const secret = "unsafe-provider-secret-/private/path";
  for (const value of ["unsafe capability", "x".repeat(129)]) {
    await withClient({ systemHealth: () => ({ ...HEALTH, capabilities: [value, secret] }) as typeof HEALTH }, async (client) => {
      const result = await client.callTool({ name: "system_health", arguments: {} });
      assert.deepEqual(errorPayload(result), { code: E_INTERNAL, message: E_INTERNAL });
      assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    });
  }
  await withClient({ systemHealth: () => ({ ...HEALTH, version: `version ${secret}` }) }, async (client) => {
    const result = await client.callTool({ name: "system_health", arguments: {} });
    assert.deepEqual(errorPayload(result), { code: E_INTERNAL, message: E_INTERNAL });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  });
});

test("maxToolOutputBytes applies to management tool responses", async () => {
  await withClient({ maxToolOutputBytes: 8, systemHealth: () => HEALTH }, async (client) => {
    assert.deepEqual(errorPayload(await client.callTool({ name: "system_health", arguments: {} })), {
      code: E_TOO_LARGE, message: E_TOO_LARGE,
    });
  });
});

test("management calls receive fixed safe audit resources and audit_tail does not audit itself", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "freerdc-mcp-management-audit-")));
  const auditLog = new HashChainAuditLog(join(directory, "audit.jsonl"));
  const secret = "provider-marker-secret-/private/path";
  const registry = new DeviceRegistry();
  let returnMalformedHealth = false;
  registry.register({ id: "device", capabilities: [] });
  try {
    await withClient({
      auditLog,
      deviceRegistry: registry,
      systemHealth: () => returnMalformedHealth ? { ...HEALTH, extra: secret } as typeof HEALTH : HEALTH,
      policyDescription: POLICY,
    }, async (client) => {
      payload(await client.callTool({ name: "device_list", arguments: {} }));
      payload(await client.callTool({ name: "system_health", arguments: {} }));
      payload(await client.callTool({ name: "policy_describe", arguments: {} }));
      returnMalformedHealth = true;
      assert.deepEqual(errorPayload(await client.callTool({ name: "system_health", arguments: {} })), {
        code: E_INTERNAL, message: E_INTERNAL,
      });
      const first = payload(await client.callTool({ name: "audit_tail", arguments: {} })).records as Array<Record<string, unknown>>;
      const second = payload(await client.callTool({ name: "audit_tail", arguments: {} })).records as Array<Record<string, unknown>>;
      assert.deepEqual(second, first);
      assert.deepEqual(first.map(({ action, resource, outcome }) => ({ action, resource, outcome })), [
        { action: "device_list", resource: "device", outcome: "started" },
        { action: "device_list", resource: "device", outcome: "succeeded" },
        { action: "system_health", resource: "system", outcome: "started" },
        { action: "system_health", resource: "system", outcome: "succeeded" },
        { action: "policy_describe", resource: "policy", outcome: "started" },
        { action: "policy_describe", resource: "policy", outcome: "succeeded" },
        { action: "system_health", resource: "system", outcome: "started" },
        { action: "system_health", resource: "system", outcome: "failed" },
      ]);
      assert.equal(first.some((record) => record.action === "audit_tail"), false);
      assert.doesNotMatch(JSON.stringify(first), new RegExp(secret));
    });
  } finally {
    auditLog.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});
