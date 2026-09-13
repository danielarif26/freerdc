# FreeRDC Migration, Replacement, and Rollback

Migration is parallel, reversible, and evidence-driven. FreeRDC does not take
ownership of another desktop-control service’s credentials, device state,
package cache, ports, or runtime.

## Phase A — coexistence

1. Leave the existing service running and responsive.
2. Build and test FreeRDC without changing the existing service’s files or
   processes.
3. Keep FreeRDC state under `~/.freerdc` or another separately approved,
   non-symlink directory.
4. Never copy device files, credentials, caches, launch agents, or other state
   between services.
5. Keep all protected paths in the FreeRDC guard denylist.

## Phase B — local validation

1. Verify port 8787 is free.
2. Start FreeRDC with a narrow test root.
3. Confirm the listener is only `127.0.0.1:8787`.
4. Verify MCP negotiation, tool inventory, audit permissions, protected-path
   rejection, and `STOP` behavior.
5. Stop the smoke runtime and confirm port 8787 is free again.

## Phase C — private remote validation

1. Provision a workspace-scoped Secure MCP Tunnel and restricted Read+Use
   runtime key.
2. Run `tunnel-client doctor` and managed-runtime health checks.
3. Create the ChatGPT custom app through **Connection: Tunnel**.
4. Execute an actual read-only FreeRDC tool from the ChatGPT UI and record the
   result.
5. Stop and restore the tunnel; confirm a new request succeeds and no prior
   mutation is replayed.

## Replacement rule

Keep your existing desktop-control service unchanged and available until
[`ACCEPTANCE.md`](ACCEPTANCE.md) shows every mandatory local gate PASS and the
genuine ChatGPT UI tool invocation PASS. Tunnel health, `doctor`, readiness,
discovery, or API-only calls are not enough to accept FreeRDC as its replacement.

Before replacing or retiring the existing service, capture the final commit,
typecheck/build results, full test total, loopback listener proof, tunnel health
proof, UI call proof, and a tested rollback procedure. Update the verified
release total if new tests are added.

## Rollback

1. Stop the FreeRDC tunnel runtime.
2. Stop FreeRDC if necessary.
3. Leave or restore the existing service unchanged.
4. Do not import state in either direction.
5. Diagnose from FreeRDC/tunnel logs and audit data without weakening controls.
6. Rerun the complete acceptance gate before another replacement attempt.

Replacing or retiring the existing service is an explicit operator action,
never an automated build step. If account provisioning or ChatGPT product
behavior blocks P7, keep your existing desktop-control service.
