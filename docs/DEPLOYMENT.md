# FreeRDC Deployment and Secure MCP Tunnel Runbook

This runbook describes the Community Edition’s local/private deployment. It
does not provision a public relay or directory listing.

## 1. Preconditions

- Typecheck, build, and tests pass.
- Any existing desktop-control service remains running and unchanged.
- TCP port 8787 is free.
- Select the smallest absolute filesystem root(s) required.
- Install the official `tunnel-client` release and verify its provenance or
  checksum.
- Create a workspace-scoped tunnel and use a separate restricted runtime
  principal with **Tunnels Read + Use**. Keep CRUD/admin credentials separate.

Official references:

- [OpenAI tunnel-client](https://github.com/openai/tunnel-client)
- [Tunnel permissions](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)
- [OpenAI: Developer Mode apps and full MCP connectors in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)

## 2. Build and local acceptance

```sh
npm run typecheck
npm run build
npm test
lsof -nP -iTCP:8787 -sTCP:LISTEN || true
```

Stop if a gate fails or another service owns port 8787.

## 3. Start FreeRDC locally

```sh
node packages/server/dist/src/cli.js \
  --root /absolute/allowed/root \
  --port 8787
```

The endpoint is `http://127.0.0.1:8787/mcp`. The production CLI does not
enable process tools. State defaults to `~/.freerdc`; its directory is mode
0700 and the hash-chain audit file is mode 0600.

Emergency stop:

```sh
touch ~/.freerdc/STOP
```

Remove the sentinel only after investigating why it was activated.

## 4. Provision the private tunnel

Create or inspect the tunnel through the official OpenAI Platform Tunnels
management path. Associate it with the target ChatGPT workspace. Store the
restricted runtime key in a user-only file, entering it without echoing it:

```sh
export CONTROL_PLANE_TUNNEL_ID='tunnel_...'
secret_file="$HOME/.config/tunnel-client/freerdc-control-plane-api-key"
(
  install -d -m 700 "$(dirname "$secret_file")"
  umask 077
  saved_stty=$(stty -g)
  trap 'stty "$saved_stty"' EXIT HUP INT TERM
  printf 'Control-plane runtime key: ' >&2
  stty -echo
  IFS= read -r CONTROL_PLANE_API_KEY
  stty "$saved_stty"
  trap - EXIT HUP INT TERM
  printf '\n' >&2
  printf '%s' "$CONTROL_PLANE_API_KEY" > "$secret_file"
  unset CONTROL_PLANE_API_KEY
  chmod 600 "$secret_file"
)
```

Never commit the key, put its literal value in a profile or shell history, or
use an admin key as the long-lived runtime credential. Keep the secret file
mode 0600.

## 5. Create and validate a profile

```sh
tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile freerdc \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp-server-url http://127.0.0.1:8787/mcp \
  --control-plane-api-key-ref "file:$secret_file" \
  --health-listen-addr 127.0.0.1:0

tunnel-client doctor --profile freerdc --explain
```

For a long-lived deployment, use the official managed runtime path:

```sh
tunnel-client runtimes connect \
  --alias freerdc \
  --tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --runtime-api-key "file:$secret_file" \
  --mcp-server-url http://127.0.0.1:8787/mcp

tunnel-client runtimes status freerdc --json
```

Report success only when `process_running`, `healthy`, and `ready` are all
true. These checks are necessary but do not prove ChatGPT UI usability.

## 5A. Zero-cost local compatibility gate

```sh
npm run test:tunnel-local
```

This uses the official client’s local development proxy and temporary local
state. A `LOCAL_SECURE_TUNNEL_COMPAT_E2E=PASS` result proves local transport
compatibility only; it does not satisfy P7 or a ChatGPT UI acceptance call.

## 6. ChatGPT UI acceptance

In ChatGPT Apps/Connectors settings, enable Developer Mode as permitted by the
workspace, create the custom MCP app with **Connection: Tunnel**, and select
the intended workspace tunnel. Confirm tool discovery, then perform an actual
read-only FreeRDC call such as `system_health`. Record the non-secret metadata
and result in [`ACCEPTANCE.md`](ACCEPTANCE.md).

FreeRDC CE is private/tunnel-capable, not directory-listed. A future public
hosted relay and account service would be required for a one-click directory
experience comparable to Remote Desktop Commander.

## 7. OAuth note

FreeRDC includes a hardened local Authorization Code + PKCE provider for
deployments where its OAuth routes are directly reachable. Do not advertise
unreachable local OAuth metadata through Secure MCP Tunnel; the deployment
uses the private tunnel boundary.

## 8. Shutdown and rollback

Stop the tunnel runtime first, then stop FreeRDC. Keep the existing service
untouched until final acceptance. If any step fails, restore the previous
service, preserve audit evidence, and rerun the complete acceptance gate
without weakening path, authentication, or policy controls.
