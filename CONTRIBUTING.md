# Contributing to FreeRDC

Thank you for helping improve FreeRDC Community Edition.

## Before opening a change

- Use a GitHub issue or discussion for substantial behavior changes so scope
  and security impact can be reviewed first.
- Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md).
- Keep changes focused. Do not add telemetry, payment dependencies, public
  listener defaults, or credential material.
- Preserve loopback binding, default-deny path policy, symlink containment,
  STOP behavior, redaction, OAuth/audit invariants, and reconnect no-replay.
- The production CLI must not expose process tools.

## Development

FreeRDC requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm audit --audit-level=high
npm ls --all
git diff --check
```

Add tests for behavior changes and use temporary, generic paths. Never include
personal machine paths, tunnel identifiers, API keys, tokens, device state, or
real user data in source, fixtures, logs, screenshots, or documentation.

By submitting a contribution, you agree that it may be distributed under the
project's `AGPL-3.0-or-later` license. You must have the right to submit the
work. Project maintainers decide whether and when to accept a contribution;
submission does not create a support or commercial commitment.

All participants must follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and
use of the FreeRDC name or logo must follow [`TRADEMARKS.md`](TRADEMARKS.md).
