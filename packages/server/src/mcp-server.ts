import { Buffer } from "node:buffer";

import { type ProcessManager, type SafeFilesystem } from "@freerdc/agent";
import { E_DEVICE_OFFLINE, E_INTERNAL, E_TOO_LARGE, FreeRdcError } from "@freerdc/protocol";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { HashChainAuditLog } from "./audit.js";
import type { DeviceRegistry } from "./device-registry.js";

const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 262_144;
const MAX_MANAGEMENT_STRING_LENGTH = 128;
const MAX_MANAGEMENT_CAPABILITIES = 64;
const MANAGEMENT_VERSION_PATTERN = /^[A-Za-z0-9._:+-]+$/;
const MANAGEMENT_CAPABILITY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SYSTEM_HEALTH_KEYS = new Set([
  "version",
  "healthy",
  "killSwitchActive",
  "filesystemEnabled",
  "processEnabled",
  "auditEnabled",
  "deviceCount",
  "onlineDeviceCount",
  "processCount",
  "capabilities",
]);
const POLICY_DESCRIPTION_KEYS = new Set(["commandRuleCount", "limits", "capabilities"]);
const POLICY_LIMIT_KEYS = new Set([
  "maxReadBytes",
  "maxWriteBytes",
  "maxSearchBytes",
  "maxOutputBytes",
  "maxSearchResults",
  "commandTimeoutMs",
  "maxFilesystemConcurrency",
  "maxCommandConcurrency",
]);

const pathSchema = z.string().min(1);
const processIdSchema = z.string().min(1);
const executableSchema = z.string().min(1).refine((value) => value.startsWith("/"), {
  message: "executable must be an absolute path.",
});
const dryRunSchema = z.enum(["off", "plan"]).default("off");
const expectedSha256Schema = z.string().min(1);
const canonicalBase64Schema = z.string().refine(isCanonicalBase64, {
  message: "Provide canonical standard Base64.",
});

const writeInputSchema = z.object({
  path: pathSchema,
  text: z.string().optional(),
  base64: canonicalBase64Schema.optional(),
  expectedSha256: expectedSha256Schema.optional(),
  dryRun: dryRunSchema,
}).refine(
  ({ text, base64 }) => (text === undefined) !== (base64 === undefined),
  { message: "Provide exactly one of text or base64." },
);

const processInputSchema = z.object({
  id: processIdSchema,
  text: z.string().optional(),
  base64: canonicalBase64Schema.optional(),
}).refine(
  ({ text, base64 }) => (text === undefined) !== (base64 === undefined),
  { message: "Provide exactly one of text or base64." },
);

function isCanonicalBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;

  const canonical = Buffer.from(value, "base64").toString("base64");
  return value === canonical || value === canonical.replace(/=+$/, "");
}

export interface CreateFreeRdcMcpServerOptions {
  readonly filesystem: SafeFilesystem;
  readonly processManager?: ProcessManager;
  readonly maxToolOutputBytes?: number;
  readonly auditLog?: HashChainAuditLog;
  readonly deviceRegistry?: DeviceRegistry;
  readonly systemHealth?: () => SystemHealthSnapshotInput;
  readonly policyDescription?: PolicyDescriptionInput;
}

/** Fixed, non-sensitive system health fields exposed through MCP. */
export interface SystemHealthSnapshotInput {
  readonly version: string;
  readonly healthy: boolean;
  readonly killSwitchActive: boolean;
  readonly filesystemEnabled: boolean;
  readonly processEnabled: boolean;
  readonly auditEnabled: boolean;
  readonly deviceCount: number;
  readonly onlineDeviceCount: number;
  readonly processCount: number;
  readonly capabilities: readonly string[];
}

/** Fixed numeric policy limits exposed through MCP. */
export interface PolicyLimitsInput {
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxSearchBytes: number;
  readonly maxOutputBytes: number;
  readonly maxSearchResults: number;
  readonly commandTimeoutMs: number;
  readonly maxFilesystemConcurrency: number;
  readonly maxCommandConcurrency: number;
}

/** Fixed, descriptive policy fields exposed through MCP. */
export interface PolicyDescriptionInput {
  readonly commandRuleCount: number;
  readonly limits: PolicyLimitsInput;
  readonly capabilities: readonly string[];
}

/** Creates the filesystem-only FreeRDC MCP server. */
export function createFreeRdcMcpServer({
  filesystem,
  processManager,
  maxToolOutputBytes = DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  auditLog,
  deviceRegistry,
  systemHealth,
  policyDescription,
}: CreateFreeRdcMcpServerOptions): McpServer {
  if (!Number.isInteger(maxToolOutputBytes) || maxToolOutputBytes <= 0) {
    throw new RangeError("maxToolOutputBytes must be a positive integer");
  }
  if (processManager !== undefined && maxToolOutputBytes < minimumProcessReadPayloadBytes()) {
    throw new RangeError("maxToolOutputBytes is too small for process tools");
  }

  const server = new McpServer({ name: "freerdc", version: "0.1.0" });
  const success = createSuccessResult(maxToolOutputBytes);
  const failure = createFailureResult();

  server.registerTool(
    "fs_stat",
    {
      inputSchema: z.object({ path: pathSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ path }) => safelyAudited(() => filesystem.stat(path), { action: "fs_stat", resource: "filesystem" }, auditLog, success, failure),
  );

  server.registerTool(
    "fs_list",
    {
      inputSchema: z.object({ path: pathSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ path }) => safelyAudited(() => filesystem.list(path), { action: "fs_list", resource: "filesystem" }, auditLog, success, failure),
  );

  server.registerTool(
    "fs_read",
    {
      inputSchema: z.object({
        path: pathSchema,
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ path, encoding }) => safelyAudited(() => {
      const data = filesystem.read(path);
      return { path, encoding, data: encoding === "base64" ? data.toString("base64") : data.toString("utf8") };
    }, { action: "fs_read", resource: "filesystem" }, auditLog, success, failure),
  );

  server.registerTool(
    "fs_search",
    {
      inputSchema: z.object({
        path: pathSchema,
        query: z.string().min(1),
        caseSensitive: z.boolean().optional(),
        maxDepth: z.number().int().nonnegative().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ path, query, caseSensitive, maxDepth }) => safelyAudited(
      () => filesystem.search(path, query, { caseSensitive, maxDepth }),
      { action: "fs_search", resource: "filesystem" },
      auditLog,
      success,
      failure,
    ),
  );

  server.registerTool(
    "fs_mkdir",
    {
      inputSchema: z.object({ path: pathSchema, dryRun: dryRunSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ path, dryRun }) => safelyAudited(
      () => filesystem.mkdir(path, { dryRun }),
      { action: "fs_mkdir", dryRun, resource: "filesystem" },
      auditLog,
      success,
      failure,
    ),
  );

  server.registerTool(
    "fs_write",
    {
      inputSchema: writeInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ path, text, base64, expectedSha256, dryRun }) => safelyAudited(
      () => filesystem.write(path, text ?? Buffer.from(base64 as string, "base64"), { expectedSha256, dryRun }),
      { action: "fs_write", dryRun, resource: "filesystem" },
      auditLog,
      success,
      failure,
    ),
  );

  server.registerTool(
    "fs_delete",
    {
      inputSchema: z.object({
        path: pathSchema,
        expectedSha256: expectedSha256Schema,
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ path, expectedSha256, dryRun }) => safelyAudited(
      () => filesystem.deleteFile(path, { expectedSha256, dryRun }),
      { action: "fs_delete", dryRun, resource: "filesystem" },
      auditLog,
      success,
      failure,
    ),
  );

  server.registerTool(
    "fs_move",
    {
      inputSchema: z.object({
        source: pathSchema,
        destination: pathSchema,
        expectedSha256: expectedSha256Schema,
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ source, destination, expectedSha256, dryRun }) => safelyAudited(
      () => filesystem.moveFile(source, destination, { expectedSha256, dryRun }),
      { action: "fs_move", dryRun, resource: "filesystem" },
      auditLog,
      success,
      failure,
    ),
  );

  if (processManager !== undefined) {
    registerProcessTools(server, processManager, maxToolOutputBytes, auditLog, success, failure);
  }

  if (deviceRegistry !== undefined) {
    server.registerTool(
      "device_list",
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      () => safelyAudited(
        () => ({ devices: deviceRegistry.list() }),
        { action: "device_list", resource: "device" },
        auditLog,
        success,
        failure,
      ),
    );
  }

  if (systemHealth !== undefined) {
    server.registerTool(
      "system_health",
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      () => safelyAudited(
        () => normalizeSystemHealthSnapshot(systemHealth()),
        { action: "system_health", resource: "system" },
        auditLog,
        success,
        failure,
      ),
    );
  }

  if (policyDescription !== undefined) {
    server.registerTool(
      "policy_describe",
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      () => safelyAudited(
        () => normalizePolicyDescription(policyDescription),
        { action: "policy_describe", resource: "policy" },
        auditLog,
        success,
        failure,
      ),
    );
  }

  if (auditLog !== undefined) {
    server.registerTool(
      "audit_tail",
      {
        inputSchema: z.object({ limit: z.number().int().positive().max(100).optional() }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      ({ limit }) => safely(() => ({ records: auditLog.tail(limit ?? 100) }), success, failure),
    );
  }

  return server;
}

function registerProcessTools(
  server: McpServer,
  processManager: ProcessManager,
  maxToolOutputBytes: number,
  auditLog: HashChainAuditLog | undefined,
  success: (payload: object) => CallToolResult,
  failure: (error: unknown) => CallToolResult,
): void {
  server.registerTool(
    "terminal_start",
    {
      inputSchema: z.object({
        executable: executableSchema,
        argv: z.array(z.string()).default([]),
        cwd: pathSchema.optional(),
        timeoutMs: z.number().int().positive().optional(),
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ executable, argv, cwd, timeoutMs, dryRun }) => safelyAuditedAsync(
      async () => processStartPayload(await processManager.start({ executable, argv, cwd, timeoutMs, dryRun })),
      { action: "terminal_start", dryRun, resource: "process" },
      auditLog,
      success,
      failure,
    ),
  );

  server.registerTool(
    "terminal_read",
    {
      inputSchema: z.object({ id: processIdSchema }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ id }) => safelyAudited(
      () => processReadPayload(processManager, id, maxToolOutputBytes),
      { action: "terminal_read", resource: "process" },
      auditLog,
      success,
      failure,
    ),
  );

  server.registerTool(
    "terminal_input",
    {
      inputSchema: processInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    ({ id, text, base64 }) => safelyAudited(() => {
      const accepted = processManager.input(id, text ?? Buffer.from(base64 as string, "base64"));
      if (!accepted) throw new FreeRdcError(E_DEVICE_OFFLINE);
      return { id, accepted };
    }, { action: "terminal_input", resource: "process" }, auditLog, success, failure),
  );

  for (const name of ["terminal_kill", "process_kill"] as const) {
    server.registerTool(
      name,
      {
        inputSchema: z.object({ id: processIdSchema, force: z.boolean().default(false) }),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      ({ id, force }) => safelyAudited(() => {
        if (!processManager.kill(id, force)) throw new FreeRdcError(E_DEVICE_OFFLINE);
        return { id, killed: true };
      }, { action: name, resource: "process" }, auditLog, success, failure),
    );
  }

  for (const name of ["terminal_list", "process_list"] as const) {
    server.registerTool(
      name,
      {
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      () => safelyAudited(
        () => ({ processes: processManager.list().map(processSummaryPayload) }),
        { action: name },
        auditLog,
        success,
        failure,
      ),
    );
  }
}

function processStartPayload(result: Awaited<ReturnType<ProcessManager["start"]>>): object {
  return "planned" in result ? { planned: true } : processSummaryPayload(result);
}

function processSummaryPayload({ id, status, startedAt }: { id: string; status: string; startedAt: string }): object {
  return { id, status, startedAt };
}

function processReadBudget(maxToolOutputBytes: number): number {
  // Start conservatively below the response cap; exact serialized size is
  // verified below before any bytes are consumed.
  return Math.max(1, Math.floor(maxToolOutputBytes / 2));
}

function processReadPayload(
  processManager: ProcessManager,
  id: string,
  maxToolOutputBytes: number,
): object {
  let budget = processReadBudget(maxToolOutputBytes);
  for (;;) {
    const result = processManager.peek(id, budget);
    if (result === undefined) throw new FreeRdcError(E_DEVICE_OFFLINE);
    const payload = processReadResultPayload(result);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= maxToolOutputBytes) {
      // The displayed prefixes are still at the front of each queue: capture
      // only appends at the tail. Commit exactly the bytes that fit.
      processManager.consume(id, result.stdout.byteLength, result.stderr.byteLength);
      return payload;
    }
    if (budget === 0) throw new FreeRdcError(E_TOO_LARGE);
    budget = Math.floor(budget / 2);
  }
}

function processReadResultPayload(result: NonNullable<ReturnType<ProcessManager["peek"]>>): object {
  const stdout = result.stdout;
  const stderr = result.stderr;
  return {
    stdout: stdout.toString("utf8"),
    ...(isUtf8(stdout) ? {} : { stdoutBase64: stdout.toString("base64") }),
    stderr: stderr.toString("utf8"),
    ...(isUtf8(stderr) ? {} : { stderrBase64: stderr.toString("base64") }),
    truncated: result.truncated,
    hasMore: result.hasMore,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
  };
}

function minimumProcessReadPayloadBytes(): number {
  // Non-UTF-8 bytes add base64 fields. Use conservative lifecycle values so a
  // process-enabled server can always make progress without discarding a
  // prefix, even at the minimum accepted output cap.
  return Buffer.byteLength(JSON.stringify(processReadResultPayload({
    stdout: Buffer.from([0xff]), stderr: Buffer.from([0xff]), truncated: true,
    hasMore: true, status: "running", exitCode: 2_147_483_647, signal: "SIGKILL",
  })), "utf8");
}

function isUtf8(value: Buffer): boolean {
  return Buffer.from(value.toString("utf8"), "utf8").equals(value);
}

function normalizeSystemHealthSnapshot(value: unknown): SystemHealthSnapshotInput {
  const snapshot = requireExactObject(value, SYSTEM_HEALTH_KEYS);
  const deviceCount = requireNonnegativeInteger(snapshot.deviceCount);
  const onlineDeviceCount = requireNonnegativeInteger(snapshot.onlineDeviceCount);
  if (onlineDeviceCount > deviceCount) throw new TypeError("Invalid management provider data");
  const normalized = {
    version: requireManagementVersion(snapshot.version),
    healthy: requireBoolean(snapshot.healthy),
    killSwitchActive: requireBoolean(snapshot.killSwitchActive),
    filesystemEnabled: requireBoolean(snapshot.filesystemEnabled),
    processEnabled: requireBoolean(snapshot.processEnabled),
    auditEnabled: requireBoolean(snapshot.auditEnabled),
    deviceCount,
    onlineDeviceCount,
    processCount: requireNonnegativeInteger(snapshot.processCount),
    capabilities: normalizeCapabilities(snapshot.capabilities),
  } satisfies SystemHealthSnapshotInput;
  return normalized;
}

function normalizePolicyDescription(value: unknown): PolicyDescriptionInput {
  const description = requireExactObject(value, POLICY_DESCRIPTION_KEYS);
  const limits = requireExactObject(description.limits, POLICY_LIMIT_KEYS);
  return {
    commandRuleCount: requireNonnegativeInteger(description.commandRuleCount),
    limits: {
      maxReadBytes: requireNonnegativeInteger(limits.maxReadBytes),
      maxWriteBytes: requireNonnegativeInteger(limits.maxWriteBytes),
      maxSearchBytes: requireNonnegativeInteger(limits.maxSearchBytes),
      maxOutputBytes: requireNonnegativeInteger(limits.maxOutputBytes),
      maxSearchResults: requireNonnegativeInteger(limits.maxSearchResults),
      commandTimeoutMs: requireNonnegativeInteger(limits.commandTimeoutMs),
      maxFilesystemConcurrency: requireNonnegativeInteger(limits.maxFilesystemConcurrency),
      maxCommandConcurrency: requireNonnegativeInteger(limits.maxCommandConcurrency),
    },
    capabilities: normalizeCapabilities(description.capabilities),
  };
}

function requireExactObject(value: unknown, allowedKeys: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid management provider data");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new TypeError("Invalid management provider data");
  if ([...allowedKeys].some((key) => !Object.hasOwn(record, key))) throw new TypeError("Invalid management provider data");
  return record;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid management provider data");
  return value;
}

function requireManagementVersion(value: unknown): string {
  const version = requireString(value);
  if (version.length === 0 || version.length > MAX_MANAGEMENT_STRING_LENGTH || !MANAGEMENT_VERSION_PATTERN.test(version)) {
    throw new TypeError("Invalid management provider data");
  }
  return version;
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("Invalid management provider data");
  return value;
}

function requireNonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError("Invalid management provider data");
  }
  return value;
}

function normalizeCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MANAGEMENT_CAPABILITIES || value.some(
    (capability) => typeof capability !== "string"
      || capability.length === 0
      || capability.length > MAX_MANAGEMENT_STRING_LENGTH
      || !MANAGEMENT_CAPABILITY_PATTERN.test(capability),
  )) {
    throw new TypeError("Invalid management provider data");
  }
  return Object.freeze([...new Set(value)].sort());
}

function createSuccessResult(maxToolOutputBytes: number): (payload: object) => CallToolResult {
  return (payload) => {
    const text = JSON.stringify(payload);
    if (Buffer.byteLength(text, "utf8") > maxToolOutputBytes) {
      return errorResult({ code: E_TOO_LARGE, message: E_TOO_LARGE });
    }
    return {
      content: [{ type: "text", text }],
      structuredContent: payload as Record<string, unknown>,
    };
  };
}

function createFailureResult(): (error: unknown) => CallToolResult {
  return (error: unknown) => errorResult(
    error instanceof FreeRdcError
      ? error.toWire()
      : { code: E_INTERNAL, message: E_INTERNAL },
  );
}

function safely(
  operation: () => object,
  success: (payload: object) => CallToolResult,
  failure: (error: unknown) => CallToolResult,
): CallToolResult {
  try {
    return success(operation());
  } catch (error) {
    return failure(error);
  }
}

interface AuditToolContext {
  readonly action: string;
  readonly dryRun?: "off" | "plan";
  readonly resource?: "filesystem" | "process" | "device" | "system" | "policy";
}

function safelyAudited(
  operation: () => object,
  context: AuditToolContext,
  auditLog: HashChainAuditLog | undefined,
  success: (payload: object) => CallToolResult,
  failure: (error: unknown) => CallToolResult,
): CallToolResult {
  if (auditLog === undefined) return safely(operation, success, failure);

  const dryRun = context.dryRun === "plan";
  if (!dryRun && !appendAudit(auditLog, context, "started", dryRun)) {
    return failure(new FreeRdcError(E_INTERNAL));
  }

  let payload: object;
  try {
    payload = operation();
  } catch (error) {
    if (!appendAudit(auditLog, context, "failed", dryRun, auditErrorCode(error))) {
      return failure(new FreeRdcError(E_INTERNAL));
    }
    return failure(error);
  }

  if (!appendAudit(auditLog, context, dryRun ? "planned" : "succeeded", dryRun)) {
    return failure(new FreeRdcError(E_INTERNAL));
  }
  return success(payload);
}

async function safelyAsync(
  operation: () => Promise<object>,
  success: (payload: object) => CallToolResult,
  failure: (error: unknown) => CallToolResult,
): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

async function safelyAuditedAsync(
  operation: () => Promise<object>,
  context: AuditToolContext,
  auditLog: HashChainAuditLog | undefined,
  success: (payload: object) => CallToolResult,
  failure: (error: unknown) => CallToolResult,
): Promise<CallToolResult> {
  if (auditLog === undefined) return safelyAsync(operation, success, failure);

  const dryRun = context.dryRun === "plan";
  if (!dryRun && !appendAudit(auditLog, context, "started", dryRun)) {
    return failure(new FreeRdcError(E_INTERNAL));
  }

  let payload: object;
  try {
    payload = await operation();
  } catch (error) {
    if (!appendAudit(auditLog, context, "failed", dryRun, auditErrorCode(error))) {
      return failure(new FreeRdcError(E_INTERNAL));
    }
    return failure(error);
  }

  if (!appendAudit(auditLog, context, dryRun ? "planned" : "succeeded", dryRun)) {
    return failure(new FreeRdcError(E_INTERNAL));
  }
  return success(payload);
}

function appendAudit(
  auditLog: HashChainAuditLog,
  context: AuditToolContext,
  outcome: "planned" | "started" | "succeeded" | "failed",
  dryRun: boolean,
  errorCode?: string,
): boolean {
  try {
    auditLog.append({
      action: context.action,
      outcome,
      dryRun,
      ...(context.resource === undefined ? {} : { resource: context.resource }),
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    return true;
  } catch {
    return false;
  }
}

function auditErrorCode(error: unknown): string {
  return error instanceof FreeRdcError ? error.toWire().code : E_INTERNAL;
}

function errorResult(payload: { code: string; message: string; details?: Record<string, unknown> }): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}
