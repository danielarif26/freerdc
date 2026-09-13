# Existing Desktop-Control Service Coexistence Baseline

This public document records the compatibility boundary for an existing
desktop-control service during FreeRDC evaluation. It intentionally omits
machine-specific paths, process identifiers, credentials, and private
reconnaissance. The existing service is the rollback path until FreeRDC’s
acceptance record contains a genuine ChatGPT UI tool invocation.

## Coexistence rules

- Leave the existing service running and unchanged during build and acceptance.
- Do not stop, restart, uninstall, reconfigure, or edit its installation,
  package/cache, device state, credentials, or launch configuration.
- Never copy device state or credentials into FreeRDC, or vice versa.
- Reserve FreeRDC’s loopback listener port and fail closed if it is occupied.
- Keep FreeRDC state and audit data in its own owner-only directory.
- Keep your existing desktop-control service as the fallback until FreeRDC is
  accepted for your use.

## Preflight checklist

- [ ] Existing service responds to its expected health check.
- [ ] Existing service process chain is live.
- [ ] FreeRDC writes are scoped to the repository and explicitly configured
      test roots.
- [ ] FreeRDC protected-path denylist is enabled.
- [ ] No credentials, tokens, device state, or caches are copied.
- [ ] FreeRDC listener port is free before startup.
- [ ] Zero-spend local test environment is confirmed.
- [ ] Rollback plan is defined before enabling a tunnel/runtime service.
- [ ] Existing service remains responsive after FreeRDC testing.

## When FreeRDC can replace the existing service

Keep your existing desktop-control service unchanged and available until all
mandatory local gates, the restricted tunnel runtime checks, the
stop/reconnect no-replay check, and a genuine ChatGPT UI tool call are recorded
as PASS in [`ACCEPTANCE.md`](ACCEPTANCE.md). If the UI call or account-side
provisioning is pending, FreeRDC is not accepted to replace it.
