# FreeRDC Editions

## Community Edition (CE) — v0.1.0

The Community Edition is the local, self-operated FreeRDC distribution:

- The MCP server runs on the operator’s machine and listens on loopback.
- Filesystem access is limited to explicitly configured roots and guard policy.
- Audit, authentication, reconnect, and kill-switch controls are included.
- OpenAI Secure MCP Tunnel may be used for private remote access when the
  operator provisions the tunnel and workspace integration.
- The CE is not listed in a public connector directory and does not include a
  hosted relay, hosted account service, or one-click onboarding.

The CE is released under AGPL-3.0-or-later. See [`LICENSE`](../LICENSE).

## Future hosted experience

A one-click directory experience comparable to Remote Desktop Commander would
require a future public hosted relay and account service. That is a separate
product/service boundary and is not included or implied by CE v0.1.0.

## Scope and acceptance

CE acceptance is evidence-driven. The previously accepted baseline was 395/395
tests; the v0.1.0 release gate is 408/408. Hosted tunnel creation, restricted
runtime credentials, doctor, managed runtime readiness, and stop/reconnect
no-replay checks may be PASS while the genuine ChatGPT UI tool invocation
remains pending. See [`ACCEPTANCE.md`](ACCEPTANCE.md).

## Security boundary

No edition should weaken loopback binding, root containment, denylist policy,
authentication, redaction, audit integrity, or no-replay behavior to simplify
onboarding. See [`THREAT-MODEL.md`](THREAT-MODEL.md) and
[`SECURITY.md`](../SECURITY.md).
