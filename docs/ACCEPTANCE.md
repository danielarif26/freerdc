# FreeRDC Acceptance Record

This public record separates repeatable implementation evidence from
account-side and product-side prerequisites. A pending item must not be
described as PASS.

## Verified implementation baseline

| Area | Status |
| --- | --- |
| Protocol, guard, filesystem, mutation, and process-policy foundations (P0–P2) | PASS |
| MCP host, audit, device registry, authenticated wire/RPC E2E (P3) | PASS |
| OAuth Authorization Code + PKCE hardening (P4) | PASS |
| Ping/disconnect hooks and reconnect/backoff/heartbeat/no-replay (P5/P5A) | PASS |
| Production loopback runtime, private state/audit, and STOP sentinel (P6) | PASS |
| P8 hardening and tunnel regression coverage | PASS |

The previously accepted baseline was `npm test` **395/395 PASS**. After the
release security coverage was added, the v0.1.0 release gate is **408/408
PASS**, with typecheck/build passing. No secret, account identifier, or
local-machine path belongs in this document.

The local Secure MCP Tunnel compatibility gate passed three consecutive times.
It used the official client’s local development proxy, no OpenAI credential,
no hosted tunnel, and no billable model/API request. This proves local
transport compatibility only.

## P7 — Secure MCP Tunnel / ChatGPT

The following account-side preparation and runtime checks are recorded:

| Check | Status | Evidence boundary |
| --- | --- | --- |
| Workspace-scoped hosted tunnel created | PASS | Non-secret tunnel metadata only |
| Restricted runtime key provisioned | PASS | Runtime principal has Tunnels Read + Use; key value is not recorded |
| `tunnel-client doctor --profile freerdc --explain` | PASS | Configuration/credential reference validation |
| Managed runtime `process_running=true`, `healthy=true`, `ready=true` | PASS | Official runtime status output |
| Stop/reconnect without mutation replay | PASS | New connection succeeds; prior mutation is not replayed |
| Genuine ChatGPT UI custom-app tool invocation | **PENDING** | Requires an actual ChatGPT UI call through Connection: Tunnel |

P7 is **NOT FULLY PASS** while the genuine ChatGPT UI invocation remains
pending. Tunnel creation, key scope, doctor, readiness, tool discovery, or an
API-only call is not a substitute for that UI evidence. Record only non-secret
tunnel/workspace metadata, timestamp, selected tool, and the observed result
when the call is completed.

## Replacement status

**KEEP YOUR EXISTING DESKTOP-CONTROL SERVICE.**

For public users, keep your existing desktop-control service unchanged and
available until all mandatory local gates and the genuine ChatGPT UI call are
recorded. Only then may FreeRDC be accepted as its replacement. Afterward,
rerun typecheck, build, and the full test suite; attach the final
tunnel/runtime evidence; and follow [`MIGRATION.md`](MIGRATION.md).
