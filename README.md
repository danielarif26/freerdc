# FreeRDC

**Give ChatGPT and Claude access to the folders you choose — and nothing else.**

FreeRDC is an MCP server for file work with AI assistants. It reads, writes,
searches and edits files and documents inside the folders you approve, and
refuses everything outside them. Anything that can run commands, click the
screen or shut the machine down is off unless you turn it on.

[Demo video](https://freerdc.sjaman.deno.net/demo.mp4) ·
[Website](https://freerdc.sjaman.deno.net/) ·
[Privacy](https://freerdc.sjaman.deno.net/privacy/local) ·
Listed on the [official MCP Registry](https://registry.modelcontextprotocol.io/) as `io.github.danielarif26/freerdc`

## Why FreeRDC

- **Containment first.** Paths outside your approved folders, `..` traversal and
  symlink escapes are rejected before any file is touched. Protected paths such
  as device keys are denied even inside a root.
- **Risky tools are opt-in.** Shell, GUI and system tools are disabled by
  default. The desktop extension exposes 23 file and document tools out of the
  box and 84 only when you enable local power.
- **Every tool is described and annotated.** In the desktop extension, each tool
  has a title, a description, input and output schemas, and read-only /
  destructive / open-world hints, so the assistant knows what it is about to do.
- **Local.** The desktop extension runs on your Mac. Your files are not sent to
  FreeRDC servers.
- **Audited.** Every operation is written to a hash-chained audit log, with a
  `STOP` file kill switch.

## Get started

### Claude Desktop (desktop extension)

1. Download `freerdc-0.1.0.mcpb` from
   [Releases](https://github.com/danielarif26/freerdc/releases/latest).
2. Open it with Claude Desktop and pick the folder(s) FreeRDC may use.
3. Leave **local power tools** off unless you need shell or GUI access.

Requires macOS and Node.js 22+. Details and privacy policy:
[`mcpb/README.md`](mcpb/README.md).

### ChatGPT (self-hosted)

Run the server locally and reach it privately through OpenAI Secure MCP Tunnel.
Do not expose the local listener to the public internet. See
[`docs/OPENAI-INTEGRATION.md`](docs/OPENAI-INTEGRATION.md) and
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### ChatGPT hosted connector (early access)

The hosted connector is in review for the ChatGPT app directory. Until it is
listed, add it in ChatGPT developer mode with the MCP URL
`https://freerdc.sjaman.deno.net/mcp`.

1. Connect FreeRDC in ChatGPT. The sign-in page shows a 10-character pairing
   code (letters A–Z and digits 2–9).
2. Download `freerdc-agent-hosted.mjs` from
   [Releases](https://github.com/danielarif26/freerdc/releases/latest).
   Requires Node.js 22+.
3. Pair this computer, choosing the folder ChatGPT may use:

   ```sh
   node freerdc-agent-hosted.mjs connect --server https://freerdc.sjaman.deno.net/mcp --code YOUR_CODE --device-id my-mac --root /absolute/allowed/folder
   ```

4. Keep the agent running while you use FreeRDC:

   ```sh
   node freerdc-agent-hosted.mjs run --device-id my-mac
   ```

The pairing code expires after about 10 minutes. The agent is a prebuilt
binary; its source is not included in this repository.

## Run from source

Requires Node.js 22+, npm and Git.

```sh
npm ci
npm run build
node packages/server/dist/src/cli.js --root /absolute/allowed/folder --port 8787
```

The server binds to `127.0.0.1` only, requires at least one explicit root,
stores state under `~/.freerdc`, and leaves process tools disabled. Create
`~/.freerdc/STOP` to activate the kill switch. Pick the narrowest folder that
fits the task — never add credentials, caches or unrelated projects to a root.

### Installer scripts

macOS or Linux:

```sh
curl -fsSLo install.sh https://raw.githubusercontent.com/danielarif26/freerdc/main/install.sh
sh install.sh
```

Windows PowerShell:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/danielarif26/freerdc/main/install.ps1 -OutFile install.ps1
.\install.ps1
```

The installers follow the mutable `main` branch. For higher assurance, review a
commit or tag and pin it with `FREERDC_REF=<tag-or-commit>`. Rerun with
`--uninstall` (macOS/Linux) or `-Uninstall` (Windows) to remove an
installer-managed copy.

## Packages

| Package | Purpose |
|---|---|
| `@freerdc/protocol` | Wire schemas, RPC contracts, errors, redaction, negotiation |
| `@freerdc/guard` | Path containment, protected-path denylist, concurrency primitives |
| `@freerdc/agent` | Filesystem, process policy, RPC dispatcher, authenticated connector |
| `@freerdc/server` | MCP tools, HTTP host, OAuth, audit log, runtime CLI |

```sh
npm run typecheck && npm run build && npm test
```

## Security

- Secrets belong in environment variables or file references — never in this
  repository, profiles, shell history or tunnel metadata.
- Report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).

## License

Released under [AGPL-3.0-or-later](LICENSE). See
[`docs/EDITIONS.md`](docs/EDITIONS.md) for what the Community Edition includes.
