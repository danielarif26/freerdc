# FreeRDC MCPB

FreeRDC MCPB is a local MCP bundle for guarded workspace file operations. It runs on your Mac with Node.js; it does not require a FreeRDC account or hosted relay.

## Installation

1. Install Node.js 22 or newer.
2. Install or open an MCPB-compatible host, then install the packaged `.mcpb` bundle.
3. If building from source, include this manifest and the compiled `server/index.mjs` entry point in the bundle. Validate with:

   `npx --yes @anthropic-ai/mcpb@2.1.2 validate mcpb/manifest.json`

The bundle is macOS-only. The local-power module resolves `/bin/zsh` when loaded, so this edition declares Darwin and Node.js `>=22.0.0` compatibility.

## Setup

Configure `Workspace directories` with one or more local directories. Each directory becomes an allowed workspace root; use absolute paths. Multiple roots let one FreeRDC instance work across separate projects or folders. Keep roots narrow and avoid selecting a home directory or other sensitive parent unless that is your intent.

`Enable local-power tools` defaults to `false`. Leave it off for the safe default: workspace-scoped filesystem tools plus local safety/audit diagnostics, with no shell, GUI, browser, system, or document-power actions. The manifest lists all 84 potential tool names for discovery, but the runtime only registers optional groups when enabled.

## Usage

Use the MCPB host's normal tool picker after installation. Start with file inspection and dry-run plans before edits. Read and write operations remain confined to configured workspace roots.

To enable the full local-power surface, explicitly set `Enable local-power tools` to `true`. This opt-in exposes all 84 potential tools, including command execution, process control, GUI/browser actions, system inspection, document conversion, and other machine-level actions. Review every requested action; browser and GUI operations can affect external sites or local applications.

The safe default makes no network calls. With local-power tools enabled, `headless_browser_get` and `headless_browser_screenshot` load the URL you provide in a local Chrome process, while `browser_open` opens the URL you provide in Chrome or Safari. `give_feedback_to_desktop_commander` opens its documented GitHub feedback page. The local search tools search workspace files and do not contact web-search providers. No browser destination is contacted unless you invoke the corresponding tool.

## Privacy Policy

### Data collection

The local edition processes workspace files on your machine and does not send them to FreeRDC servers. It collects only data needed for an operation you invoke: selected paths, file contents or document data needed to complete that operation, command/process or GUI/browser data when those tools are enabled and called, and bounded audit metadata such as action, outcome, resource category, timestamp, and hash-chain fields. Browser cookies and local site storage belong to the local browser profile and are not uploaded by this bundle.

### Usage

Collected local data is used to perform requested workspace, local-power, document, browser, GUI, and audit operations; enforce workspace containment and safety limits; and show results in the MCP client. FreeRDC does not use local-edition data for advertising or automatic model training.

### Storage

The extension stores a bounded append-only audit log in a private operating-system temporary directory while the STDIO server is running. It closes the log and removes that directory during normal shutdown. Temporary browser, screenshot, and document-conversion directories are also cleaned up by their operation cleanup handlers on normal completion; files you explicitly save remain in your workspace. The local STDIO process has no FreeRDC server-side storage.

### Third-party sharing

The default configuration makes no network calls and does not share workspace data with FreeRDC or another third party. If you explicitly invoke an opt-in browser tool, the local browser sends ordinary web requests to the URL you supplied; the feedback tool opens its documented GitHub destination. Those sites receive the data normally included in browser requests and apply their own privacy and retention policies. This standalone extension does not configure a FreeRDC hosted relay or remote-device transport.

### Data retention and deletion

The extension removes its temporary audit directory during normal shutdown. An abrupt crash or machine power loss can leave temporary files until the operating system or you removes them. Workspace files and screenshots/documents you ask FreeRDC to create remain until you delete them. External sites and providers control their own retention.

### Contact

For privacy questions, deletion requests, installation help, or bug reports, use [FreeRDC Support](https://freerdc.sjaman.deno.net/support). Do not post secrets, credentials, private paths, or workspace data in public issues.

## Links

- [Privacy policy](https://freerdc.sjaman.deno.net/privacy)
- [Support](https://freerdc.sjaman.deno.net/support)
- [Source repository](https://github.com/danielarif26/freerdc)
- [AGPL-3.0-or-later license](https://github.com/danielarif26/freerdc/blob/main/LICENSE)
