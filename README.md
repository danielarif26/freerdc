# FreeRDC — Private Desktop MCP Bridge for ChatGPT

FreeRDC Community Edition (CE) is a loopback-first MCP bridge for giving a
remote MCP client narrowly scoped access to selected local resources. It is
designed to run locally and can be reached privately through OpenAI Secure MCP
Tunnel. The CE is not listed in a public connector directory and does not
include a hosted relay or account service.

## What is included

- MCP protocol schemas, canonical errors, redaction, capability negotiation,
  and an authenticated Ed25519 wire handshake.
- Guarded filesystem read/search/mutation APIs with containment, denylist, size
  limits, dry-run support, and a kill switch.
- An argv-only process manager and RPC dispatcher. The production CLI leaves
  process tools disabled.
- A loopback MCP HTTP host, authenticated WebSocket agent transport,
  backpressure, device registry, audit log, management tools, and OAuth
  Authorization Code + PKCE support for deployments that expose those routes
  directly.
- Reconnect with bounded backoff and heartbeat liveness. Mutating RPCs are not
  replayed across connector generations.
- A production `freerdc-server` runtime with explicit roots, a loopback-only
  listener, owner-only state/audit files, and a `STOP` sentinel.

## Acceptance status

The previously accepted implementation baseline was **395/395 tests passing**.
After the release security tests were added, the v0.1.0 gate is **408/408
passing**, with typecheck and build also passing. The local Secure MCP Tunnel
compatibility gate has passed in the recorded evidence.

Hosted tunnel setup, a restricted runtime key, tunnel doctor, managed runtime
health, and stop/reconnect no-replay checks are recorded. A genuine ChatGPT UI
tool invocation remains pending, so P7 is not fully PASS and your existing
desktop-control service must remain available until that evidence is collected.
See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

## Packages

- `@freerdc/protocol`: wire schemas, RPC contracts, errors, redaction, and
  negotiation.
- `@freerdc/guard`: path containment, protected-path denylist, and concurrency
  primitives.
- `@freerdc/agent`: filesystem, process policy/manager, RPC dispatcher,
  authenticated connector, and reconnect supervisor.
- `@freerdc/server`: MCP tools/HTTP host, wire hub, OAuth, audit, and the
  production runtime/CLI.

## Build and test

```sh
npm run typecheck
npm run build
npm test
```

## Install from GitHub

The source installers require Node.js 22 or newer, npm, and Git. They install
into a user-owned application-data directory, run `npm ci` and the build, and
create a `freerdc-server` launcher without adding telemetry or payment code.

Security warning: these source installers currently follow the repository's
default branch (`main`), which is mutable. For higher assurance, review and pin
a specific commit or tag with `FREERDC_REF` rather than following the branch.

macOS or Linux:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/danielarif26/freerdc/main/install.sh
sh install.sh
```

For a reviewed tag or commit:

```sh
FREERDC_REF=<reviewed-tag-or-commit> sh install.sh
```

Windows PowerShell:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/danielarif26/freerdc/main/install.ps1 -OutFile install.ps1
.\install.ps1
```

For a reviewed tag or commit:

```powershell
$env:FREERDC_REF = '<reviewed-tag-or-commit>'
.\install.ps1
```

Add the launcher directory printed by the installer to your user `PATH` if you
want to invoke `freerdc-server` by name. To remove only an installer-managed
copy, rerun the downloaded script with `--uninstall` on macOS/Linux or
`-Uninstall` on Windows. Both uninstallers verify their management marker and
refuse to remove an unrecognized directory.

## Run locally

```sh
npm run build
node packages/server/dist/src/cli.js --root /absolute/allowed/root --port 8787
```

The CLI binds only to `127.0.0.1`, requires at least one explicit root, stores
state under `~/.freerdc` by default, and does not expose process tools. Create
`~/.freerdc/STOP` to activate the kill switch. Choose the narrowest root that
fits the task; never add private credentials, caches, or unrelated project
directories to an allowlist.

## ChatGPT connectivity

Use OpenAI Secure MCP Tunnel for private remote access; do not expose the local
listener directly to the public internet. The CE can be used with a
workspace-scoped tunnel and a restricted runtime key, but it is not a
directory-listed app. A future public hosted relay and account service would
be required for a one-click directory experience comparable to Remote Desktop
Commander. Follow [`docs/OPENAI-INTEGRATION.md`](docs/OPENAI-INTEGRATION.md)
and [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Safety invariants

- The MCP listener remains loopback-only; remote access uses the private tunnel
  boundary.
- Protected paths are rejected by guard policy before filesystem access.
- Existing desktop-control tools/state are not reused as FreeRDC state and are
  retained until FreeRDC is accepted.
- Secret values belong in environment or file references, never in this
  repository, profiles, shell history, or tunnel metadata.
- The implementation does not require a paid model/API request to run its
  local tests.

FreeRDC Community Edition is released under
[`AGPL-3.0-or-later`](LICENSE). See [`docs/EDITIONS.md`](docs/EDITIONS.md) for
the CE scope and [`SECURITY.md`](SECURITY.md) for responsible reporting.
