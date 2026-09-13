# OpenAI Secure MCP Tunnel Integration

FreeRDC Community Edition runs its MCP server locally and binds the server to
the loopback interface. OpenAI Secure MCP Tunnel can provide a private,
workspace-scoped path from ChatGPT to that local endpoint. FreeRDC does not
require or provide a public inbound listener.

## What the CE supports

- Local MCP use with explicitly configured filesystem roots.
- Private access through a hosted Secure MCP Tunnel.
- A restricted runtime principal/key with Tunnels Read + Use.
- ChatGPT custom-app configuration using **Connection: Tunnel**, where the
  workspace has the required ChatGPT feature enabled.

The CE is not listed in a public connector directory. A future one-click
directory experience comparable to Remote Desktop Commander would require a
public hosted relay and account service; that service is outside this edition.

The OpenAI Apps SDK documentation describes one possible route for packaging a
public ChatGPT app. That packaging work and the public backend/relay it would
require are distinct from connecting this local Community Edition through a
private tunnel; this project makes no claim of OpenAI endorsement.

## Integration boundary

The path is:

```text
ChatGPT custom app → OpenAI Secure MCP Tunnel → 127.0.0.1 FreeRDC MCP endpoint
```

Tunnel creation and runtime health are necessary preparation, not proof of
ChatGPT usability. Final acceptance requires a genuine ChatGPT UI tool call,
recorded without secrets in [`ACCEPTANCE.md`](ACCEPTANCE.md).

## Credential and workspace guidance

Create the tunnel in the official OpenAI Platform Tunnels management path and
associate it with the intended ChatGPT workspace. Use a separate restricted
runtime key with **Tunnels Read + Use**. Keep CRUD/admin credentials separate;
provide the runtime key through an environment or file reference, never as a
literal in a repository, profile, command history, or audit record.

The production tunnel profile uses the official `sample_mcp_remote_no_auth`
model and points directly to `http://127.0.0.1:8787/mcp`. Do not advertise
FreeRDC’s local OAuth discovery endpoints through the tunnel unless a supported
route is documented and verified.

## No-auth authorization boundary

The `sample_mcp_remote_no_auth` profile does not provide an assumed FreeRDC
end-user login, approval prompt, or per-user access-control list. Availability
of the tunnel and custom app is governed by the ChatGPT workspace and tunnel
configuration. This project does not define or infer those configuration or
permission semantics. Treat anyone who can access the custom app as authorized
for all tools exposed by the connected FreeRDC instance.

Use the narrowest filesystem roots possible, preferably dedicated test or work
directories. In a multi-member workspace, do not rely on workspace membership
as a per-user authorization boundary and do not expose a home directory,
credentials, or unrelated project trees.

## Verification sequence

1. Run local typecheck, build, and tests.
2. Start FreeRDC on loopback with a narrow test root.
3. Run `tunnel-client doctor --profile freerdc --explain`.
4. Confirm managed runtime status reports
   `process_running=true`, `healthy=true`, and `ready=true`.
5. In ChatGPT, configure the custom app with **Connection: Tunnel** and verify
   tool discovery.
6. Call a controlled read-only tool such as `system_health` from the ChatGPT
   UI and record the result.
7. Test stop/reconnect and confirm that no prior mutation is replayed.

The repository also includes a zero-cost local compatibility gate,
`npm run test:tunnel-local`. That gate uses the client’s local development proxy
and no OpenAI credential or billable model/API request; it does not replace the
ChatGPT UI step.

## Official references

- [OpenAI tunnel-client](https://github.com/openai/tunnel-client)
- [Tunnel permissions](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md)
- [OpenAI: Developer Mode apps and full MCP connectors in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta)
- [OpenAI Apps SDK documentation](https://developers.openai.com/apps-sdk/)
