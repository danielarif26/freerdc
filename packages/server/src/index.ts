export const P3_SERVER_PLACEHOLDER_VERSION = "0.1.0";

export {
  HashChainAuditLog,
  type AuditAppendInput,
  type AuditOutcome,
  type AuditRecord,
  type HashChainAuditLogOptions,
} from "./audit.js";

export {
  createFreeRdcMcpServer,
  type CreateFreeRdcMcpServerOptions,
  type PolicyDescriptionInput,
  type PolicyLimitsInput,
  type SystemHealthSnapshotInput,
} from "./mcp-server.js";

export {
  DeviceRegistry,
  type DeviceRecord,
  type DeviceRegistration,
  type DeviceStatus,
} from "./device-registry.js";

export { WireHub, WireTransport, type WireHubOptions } from './wire-hub.js';

export {
  DEFAULT_BUFFERED_AMOUNT_CEILING,
  WIRE_WS_MAX_PAYLOAD,
  WireWsTransport,
  type WireSendSocket,
  type WireWsTransportOptions,
} from './wire-ws-transport.js';

export {
  AGENT_UPGRADE_PATH,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  attachAgentWebSocketServer,
  type AgentWebSocketServer,
  type AgentWebSocketServerOptions,
} from './wire-ws-server.js';

export {
  DEFAULT_MCP_HTTP_PORT,
  LOOPBACK_HOST,
  LoopbackMcpHttpHost,
  createMcpHttpHost,
  type LoopbackMcpHttpHostOptions,
  type McpHttpAddress,
} from "./http-host.js";

export {
  MCP_ACCESS_SCOPE,
  createOAuthProvider,
  type AuthResult,
  type OAuthApprovalCallback,
  type OAuthApprovalRequest,
  type OAuthApprovalResult,
  type OAuthClientConfig,
  type OAuthProvider,
  type OAuthProviderConfig,
} from "./oauth.js";

export {
  FreeRdcRuntime,
  createFreeRdcRuntime,
  type FreeRdcRuntimeOptions,
} from "./runtime.js";
