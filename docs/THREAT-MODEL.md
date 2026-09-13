# FreeRDC Threat Model

## Security objective

FreeRDC grants a remote MCP client narrowly controlled access to selected local
resources without turning the host into a general remote shell or exposing a
new public inbound listener. It fails closed when identity, path containment,
protocol framing, policy, liveness, or audit invariants cannot be established.

## Assets and trust boundaries

Assets include files outside configured roots, protected project/state paths,
credentials and environment secrets, local process state, FreeRDC audit/state
files, device signing keys, OAuth codes/tokens, and any existing
desktop-control service. Trust boundaries are: ChatGPT/OpenAI control plane →
Secure MCP Tunnel → loopback MCP endpoint; server wire hub → authenticated
agent WebSocket; MCP/RPC input → filesystem/process policy; and runtime → local
state/audit storage.

## Principal threats and controls

| Threat | Control |
| --- | --- |
| Public network exposure | Production server binds only to `127.0.0.1`; remote access is outbound through Secure MCP Tunnel. |
| Path traversal or symlink escape | Canonical root containment, realpath checks, protected-path denylist, and symlink tests. |
| Access to protected project/state | Guard denylist rejects protected roots and descendants before filesystem access. |
| Arbitrary shell execution | Process manager is argv-only with `shell=false`, executable/argument policy, and scrubbed environment; production CLI leaves process tools disabled. |
| Secret leakage | Structured errors, redaction, bounded output, and no argv/env in summaries or audit records. |
| Unauthorized device | Ed25519 challenge/response over a domain-separated transcript; unknown IDs and invalid signatures fail closed. |
| Replay across reconnects | Fresh connector/dispatcher generations; mutating RPCs have no reconnect queue or replay path. |
| Stale connection | Heartbeat ping/pong, nonce matching, timeout close, and bounded reconnect backoff with jitter. |
| Memory/backpressure abuse | WebSocket payload/buffer ceilings, bounded MCP output, request caps, and expiry pruning. |
| OAuth interception/replay | Authorization Code + PKCE S256, exact loopback redirect matching, single-use codes, digests, and TTL limits. |
| OAuth handler failure | Async rejection containment, sanitized `server_error`, no-store auth failures, and close-time revocation. |
| Audit tampering | Append-only hash-chain JSONL, complete-chain verification, and owner-only file mode. |
| Emergency stop | `STOP` sentinel makes filesystem/process operations and health fail closed. |
| Existing-service disruption | Mandatory coexistence, no state copying/reuse, and rollback retaining the existing service. |
| Unintended tunnel/custom-app access | The documented no-auth tunnel path has no assumed per-user authorization at the FreeRDC endpoint; anyone who can access the custom app must be treated as authorized for every exposed tool. |

## Secure MCP Tunnel credential model

The long-lived tunnel runtime uses a restricted key through environment/file
indirection with only Tunnels Read + Use. Tunnel CRUD/admin credentials are
separate and must never be stored in the daemon profile. Scope the tunnel to the
intended ChatGPT workspace before connector selection.

## No-auth tunnel authorization

The production tunnel profile uses the `sample_mcp_remote_no_auth` sample. On
this path, do not assume that FreeRDC adds an end-user login, approval prompt,
or per-user access-control list. Whether the tunnel or custom app is available
is governed by the ChatGPT workspace and tunnel configuration; this project
does not define or infer those configuration semantics. Treat anyone who can
access the custom app as authorized for all tools exposed by that FreeRDC
instance.

Configure the instance with the narrowest roots that meet the task, preferably
dedicated test or work directories. This is especially important in a
multi-member workspace: do not expose a home directory, credentials, or an
unrelated project on the assumption that workspace membership provides a
separate per-user authorization boundary.

Official references:

- [OpenAI tunnel-client](https://github.com/openai/tunnel-client)
- [Tunnel permissions](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)

## Residual risks and non-goals

- Operators must still choose the narrowest permitted root; dedicated test or
  work directories reduce the exposure of authorized custom-app users.
- Process tools are disabled by the production CLI. Enabling them requires a
  separately reviewed explicit command policy.
- Tunnel health does not prove ChatGPT connector usability; final acceptance
  requires a genuine ChatGPT UI tool invocation.
- Self-hosted OAuth endpoints are not assumed reachable through Secure MCP
  Tunnel. Do not advertise local OAuth discovery unless a supported route is
  documented and verified.
- Compromise of the local account or an authorized signing key is outside this
  protocol’s ability to prevent; OS and key hygiene remain required.

## Invariants that must not be relaxed

1. Keep the MCP listener loopback-only.
2. Never copy another service’s device/state data into FreeRDC.
3. Never remove protected paths from the denylist to make a test pass.
4. Never add replay/queue semantics for mutating RPCs across reconnects.
5. Never place literal API/admin keys in repository files, profiles, or history.
6. Never use an admin key as the long-lived tunnel runtime key.
7. Never retire the existing service before genuine ChatGPT UI E2E acceptance.
