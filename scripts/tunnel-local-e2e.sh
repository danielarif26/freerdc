#!/bin/bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_root"

test_port=${FREERDC_TUNNEL_TEST_PORT:-8787}
case "$test_port" in
  ''|*[!0-9]*) echo "FREERDC_TUNNEL_TEST_PORT must be an integer from 1 to 65535" >&2; exit 2 ;;
esac
if [ "$test_port" -lt 1 ] || [ "$test_port" -gt 65535 ]; then
  echo "FREERDC_TUNNEL_TEST_PORT must be an integer from 1 to 65535" >&2
  exit 2
fi

if command -v tunnel-client >/dev/null 2>&1; then
  tunnel_client=$(command -v tunnel-client)
elif [ -x "$HOME/.local/bin/tunnel-client" ]; then
  tunnel_client="$HOME/.local/bin/tunnel-client"
else
  echo "tunnel-client not found; install the official OpenAI release first" >&2
  exit 2
fi

if lsof -nP -iTCP:"$test_port" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "TCP $test_port is already in use" >&2
  exit 1
fi

root=$(mktemp -d /private/tmp/freerdc-tunnel-root.XXXXXX)
state_dir=$(mktemp -d /private/tmp/freerdc-tunnel-state.XXXXXX)
rmdir "$state_dir"
info=$(mktemp /private/tmp/freerdc-tunnel-info.XXXXXX)
health=$(mktemp /private/tmp/freerdc-tunnel-health.XXXXXX)
rm -f "$info" "$health"
server_out=$(mktemp /private/tmp/freerdc-tunnel-server-out.XXXXXX)
server_err=$(mktemp /private/tmp/freerdc-tunnel-server-err.XXXXXX)
proxy_out=$(mktemp /private/tmp/freerdc-tunnel-proxy-out.XXXXXX)
proxy_err=$(mktemp /private/tmp/freerdc-tunnel-proxy-err.XXXXXX)
server_pid=''
proxy_pid=''

cleanup() {
  [ -z "$proxy_pid" ] || kill "$proxy_pid" 2>/dev/null || true
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  [ -z "$proxy_pid" ] || wait "$proxy_pid" 2>/dev/null || true
  [ -z "$server_pid" ] || wait "$server_pid" 2>/dev/null || true
  rm -rf "$root" "$state_dir" "$info" "$health" "$server_out" "$server_err" "$proxy_out" "$proxy_err"
}
trap cleanup EXIT

npm run build >/dev/null
node packages/server/dist/src/cli.js \
  --root "$root" \
  --state-dir "$state_dir" \
  --port "$test_port" >"$server_out" 2>"$server_err" &
server_pid=$!

for _ in $(seq 1 80); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid" 2>/dev/null || true
    cat "$server_err" >&2
    echo "FreeRDC exited before binding TCP $test_port" >&2
    exit 1
  fi
  listener_pids=$(lsof -nP -t -iTCP:"$test_port" -sTCP:LISTEN 2>/dev/null | sort -u || true)
  if printf '%s\n' "$listener_pids" | grep -qx "$server_pid"; then break; fi
  if [ -n "$listener_pids" ]; then
    echo "TCP $test_port was claimed by an unexpected process (pid(s): $(printf '%s' "$listener_pids" | tr '\n' ' '))" >&2
    exit 1
  fi
  sleep 0.1
done
listener_pids=$(lsof -nP -t -iTCP:"$test_port" -sTCP:LISTEN 2>/dev/null | sort -u || true)
printf '%s\n' "$listener_pids" | grep -qx "$server_pid" || { echo "FreeRDC did not bind TCP $test_port" >&2; cat "$server_err" >&2; exit 1; }

"$tunnel_client" dev proxy \
  --mcp-server-url "http://127.0.0.1:$test_port/mcp" \
  --url-file "$info" \
  --health-url-file "$health" \
  --readiness-timeout 15s \
  --response-timeout 30s \
  --duration 90s >"$proxy_out" 2>"$proxy_err" &
proxy_pid=$!

for _ in $(seq 1 120); do
  if [ -s "$info" ] && [ -s "$health" ]; then break; fi
  if ! kill -0 "$proxy_pid" 2>/dev/null; then cat "$proxy_err" >&2; exit 1; fi
  sleep 0.1
done
[ -s "$info" ] && [ -s "$health" ] || { echo "local tunnel proxy did not become ready" >&2; cat "$proxy_err" >&2; exit 1; }

health_base=$(cat "$health")
test "$(curl -fsS "$health_base/healthz")" = "live"
test "$(curl -fsS "$health_base/readyz")" = "ready"

export MCP_URL=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).mcp_url)' "$info")
export TEST_ROOT="$root"
node --input-type=module <<'NODE'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'freerdc-local-tunnel-e2e', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
const transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_URL));
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort();
for (const required of ['fs_read', 'fs_write', 'system_health']) {
  if (!names.includes(required)) throw new Error(`missing tool: ${required}`);
}

const path = `${process.env.TEST_ROOT}/tunnel-proof.txt`;
const write = await client.callTool({
  name: 'fs_write',
  arguments: { path, text: 'local tunnel proof', dryRun: 'off' },
});
if (write.isError) throw new Error('fs_write failed through tunnel proxy');

const read = await client.callTool({ name: 'fs_read', arguments: { path } });
if (read.isError) throw new Error('fs_read failed through tunnel proxy');
const text = read.content?.find((item) => item.type === 'text')?.text ?? '';
if (!text.includes('local tunnel proof')) throw new Error('write/read tunnel round-trip mismatch');

const health = await client.callTool({ name: 'system_health', arguments: {} });
if (health.isError) throw new Error('system_health failed through tunnel proxy');

console.log(`protocol=${client.getNegotiatedProtocolVersion()}`);
console.log(`tools=${names.join(',')}`);
console.log('write_read_roundtrip=PASS');
console.log('system_health=PASS');

await transport.terminateSession().catch(() => undefined);
await client.close().catch(() => undefined);
NODE

[ -s "$state_dir/audit.jsonl" ] || { echo "audit log is empty" >&2; exit 1; }
echo "audit_records=$(wc -l < "$state_dir/audit.jsonl" | tr -d ' ')"
echo "LOCAL_SECURE_TUNNEL_COMPAT_E2E=PASS"
