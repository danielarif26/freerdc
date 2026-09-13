import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import test from 'node:test';

import { createEd25519Signer, WireConnector } from '@freerdc/agent';
import { localhostAllowedOrigins, McpServer } from '@modelcontextprotocol/server';
import { WebSocket } from 'ws';

import { DeviceRegistry } from '../src/device-registry.js';
import { createMcpHttpHost } from '../src/http-host.js';
import { createOAuthProvider, MCP_ACCESS_SCOPE, type OAuthProvider } from '../src/oauth.js';
import { WireHub, WireTransport } from '../src/wire-hub.js';
import {
  BACKPRESSURE_CLOSE_CODE,
  DEFAULT_BUFFERED_AMOUNT_CEILING,
  WIRE_WS_MAX_PAYLOAD,
  WireWsTransport,
} from '../src/wire-ws-transport.js';

class TrackingHub extends WireHub {
  attachCount = 0;
  detachCount = 0;
  received: unknown[] = [];

  override attach(transport: WireTransport): string {
    this.attachCount += 1;
    return super.attach(transport);
  }

  override detach(sessionId: string): void {
    this.detachCount += 1;
    super.detach(sessionId);
  }

  override receive(sessionId: string, input: unknown): void {
    this.received.push(input);
    super.receive(sessionId, input);
  }
}

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function createMcpServer(): McpServer {
  return new McpServer({ name: 'test-server', version: '0.0.0' });
}

function fixture(overrides: { handshakeTimeoutMs?: number; privateKey?: KeyObject; oauth?: OAuthProvider } = {}) {
  const pair = generateKeyPairSync('ed25519');
  const registry = new DeviceRegistry();
  const hub = new TrackingHub({
    registry,
    authorizedKeys: new Map([['device-1', pair.publicKey]]),
    supportedCapabilities: ['fs.v1'],
  });
  const host = createMcpHttpHost(createMcpServer, 0, {
    hub,
    handshakeTimeoutMs: overrides.handshakeTimeoutMs,
    oauth: overrides.oauth,
  });
  return { pair, registry, hub, host };
}

function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: responseBody,
        });
      });
    });
    clientRequest.once('error', reject);
    if (body !== undefined) {
      clientRequest.end(body);
      return;
    }
    clientRequest.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await delay(10);
  }
}

function openClient(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, headers === undefined ? undefined : { headers });
    client.once('open', () => resolve(client));
    client.once('error', reject);
  });
}

function onceClose(client: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    client.once('close', (code) => resolve(code));
  });
}

function connectRejected(
  url: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url, headers === undefined ? undefined : { headers });
    client.once('unexpected-response', (_req, res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    client.once('open', () => {
      client.close();
      reject(new Error('upgrade unexpectedly succeeded'));
    });
    client.once('error', () => {
      // ws emits error after unexpected-response; ignore
    });
  });
}

function rawUpgrade(port: number, requestTarget: string, extraHeaders: string[]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => {
      const lines = [
        `GET ${requestTarget} HTTP/1.1`,
        ...extraHeaders,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.includes('\r\n\r\n')) {
        const [head, body = ''] = data.split('\r\n\r\n');
        const status = Number((head ?? '').split(' ')[1] ?? 0);
        socket.destroy();
        resolve({ status, body });
      }
    });
    socket.once('error', reject);
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('raw upgrade timeout'));
    });
  });
}

function helloEnvelope(deviceId = 'device-1'): unknown {
  return {
    v: 'freerdc-wire/1',
    id: 'frame-1',
    kind: 'hello',
    ts: 1,
    payload: {
      type: 'hello',
      wireId: 'freerdc-wire',
      deviceId,
      version: { major: 1, minor: 0 },
      capabilities: ['fs.v1'],
    },
  };
}

test('localhostAllowedOrigins pin hostnames without scheme or port', () => {
  const origins = localhostAllowedOrigins();
  assert.deepEqual(origins, ['localhost', '127.0.0.1', '[::1]']);
  for (const hostname of origins) {
    assert.equal(hostname.includes('://'), false);
    assert.doesNotMatch(hostname, /:\d+$/);
  }
});

test('existing /mcp host behavior is unchanged when the wire hub is attached', async () => {
  const { host } = fixture();
  try {
    const { port } = await host.start();
    const unknown = await request(port, '/not-mcp');
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.body, 'Not Found');

    const badHost = await request(port, '/mcp', {
      host: 'example.invalid',
      origin: `http://localhost:${port}`,
    });
    assert.equal(badHost.statusCode, 403);

    const allowed = await request(port, '/mcp', {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      'content-type': 'application/json',
      accept: 'application/json',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'unsupported/test' }));
    assert.notEqual(allowed.statusCode, 404);
    assert.notEqual(allowed.statusCode, 403);
  } finally {
    await host.close();
  }
});

test('OAuth-enabled host still accepts the real /agent WebSocket upgrade', async () => {
  const oauth = createOAuthProvider({
    clients: [{
      clientId: 'ws-test',
      clientName: 'WebSocket Test',
      redirectUris: ['http://127.0.0.1:4321/callback'],
      scopes: [MCP_ACCESS_SCOPE],
    }],
    approve: async () => true,
  });
  const { host, hub } = fixture({ oauth });
  try {
    const { port } = await host.start();
    const client = await openClient(`ws://127.0.0.1:${port}/agent`);
    await waitFor(() => hub.attachCount === 1);
    const closed = onceClose(client);
    client.close();
    await closed;
    await waitFor(() => hub.detachCount === 1);
  } finally {
    await host.close();
  }
});

test('ephemeral loopback host accepts /agent and attach/detach exactly once', async () => {
  const { host, hub } = fixture();
  try {
    const { port } = await host.start();
    const client = await openClient(`ws://127.0.0.1:${port}/agent`);
    await waitFor(() => hub.attachCount === 1);
    assert.equal(hub.detachCount, 0);
    const closed = onceClose(client);
    client.close();
    await closed;
    await waitFor(() => hub.detachCount === 1);
    assert.equal(hub.attachCount, 1);
    assert.equal(hub.detachCount, 1);
  } finally {
    await host.close();
  }
});

test('upgrade rejects wrong path, query, Host, and Origin; allows missing and localhost Origin', async () => {
  const { host } = fixture();
  try {
    const { port } = await host.start();
    const endpoint = `ws://127.0.0.1:${port}/agent`;

    const wrongPath = await connectRejected(`ws://127.0.0.1:${port}/nope`);
    assert.equal(wrongPath.status, 403);
    assert.equal(wrongPath.body, '');

    const query = await connectRejected(`${endpoint}?x=1`);
    assert.equal(query.status, 403);
    assert.equal(query.body, '');

    const missingHost = await rawUpgrade(port, '/agent', []);
    assert.equal(missingHost.status, 403);
    assert.equal(missingHost.body, '');
    assert.doesNotMatch(missingHost.body, /missing_host|invalid_host|Host header/i);

    const foreignHost = await rawUpgrade(port, '/agent', ['Host: example.invalid']);
    assert.equal(foreignHost.status, 403);
    assert.doesNotMatch(foreignHost.body, /invalid_host|example\.invalid/);

    const foreignOrigin = await connectRejected(endpoint, { Origin: 'https://example.invalid' });
    assert.equal(foreignOrigin.status, 403);
    assert.doesNotMatch(foreignOrigin.body, /invalid_origin|example\.invalid/);

    const opaqueOrigin = await connectRejected(endpoint, { Origin: 'null' });
    assert.equal(opaqueOrigin.status, 403);
    assert.doesNotMatch(opaqueOrigin.body, /invalid_origin|null/);

    const noOrigin = await openClient(endpoint);
    noOrigin.close();
    await onceClose(noOrigin);

    const localhostOrigin = await openClient(endpoint, { Origin: 'http://localhost:9' });
    localhostOrigin.close();
    await onceClose(localhostOrigin);
  } finally {
    await host.close();
  }
});

test('TEXT frames delivered as Buffer with isBinary=false reach hub.receive', async () => {
  const { host, hub } = fixture();
  try {
    const { port } = await host.start();
    const client = await openClient(`ws://127.0.0.1:${port}/agent`);
    client.send(Buffer.from(JSON.stringify(helloEnvelope())), { binary: false });
    await waitFor(() => hub.received.length === 1);
    assert.equal((hub.received[0] as { kind: string }).kind, 'hello');
    client.close();
    await onceClose(client);
  } finally {
    await host.close();
  }
});

test('binary is 1003, malformed JSON is 1007, oversize is never delivered', async () => {
  const { host, hub } = fixture();
  try {
    const { port } = await host.start();
    const endpoint = `ws://127.0.0.1:${port}/agent`;

    const binary = await openClient(endpoint);
    const binaryClosed = onceClose(binary);
    binary.send(Buffer.from('not-text'), { binary: true });
    assert.equal(await binaryClosed, 1003);
    await waitFor(() => hub.detachCount === 1);
    assert.equal(hub.received.length, 0);

    const malformed = await openClient(endpoint);
    const malformedClosed = onceClose(malformed);
    malformed.send('{not-json');
    assert.equal(await malformedClosed, 1007);
    await waitFor(() => hub.detachCount === 2);

    const oversize = await openClient(endpoint);
    const oversizeClosed = onceClose(oversize);
    const before = hub.received.length;
    oversize.send('x'.repeat(WIRE_WS_MAX_PAYLOAD + 1));
    const oversizeCode = await oversizeClosed;
    assert.ok(oversizeCode === 1009 || oversizeCode === 1006, `unexpected oversize close ${oversizeCode}`);
    await waitFor(() => hub.detachCount === 3);
    assert.equal(hub.received.length, before);
  } finally {
    await host.close();
  }
});

test('unauthenticated handshake timeout cleans up exactly once', async () => {
  const { host, hub } = fixture({ handshakeTimeoutMs: 40 });
  try {
    const { port } = await host.start();
    const client = await openClient(`ws://127.0.0.1:${port}/agent`);
    const closed = onceClose(client);
    await closed;
    await waitFor(() => hub.detachCount === 1);
    await delay(80);
    assert.equal(hub.attachCount, 1);
    assert.equal(hub.detachCount, 1);
  } finally {
    await host.close();
  }
});

test('real connector completes WireHub hello/challenge/auth/ready', async () => {
  const { host, hub, pair, registry } = fixture();
  try {
    const { port } = await host.start();
    const live = new WireConnector({
      endpoint: `ws://127.0.0.1:${port}/agent`,
      deviceId: 'device-1',
      capabilities: ['fs.v1'],
      signer: createEd25519Signer(pair.privateKey),
    });
    await live.connect();
    assert.equal(live.isReady, true);
    assert.equal(registry.get('device-1')?.status, 'online');
    assert.equal(hub.attachCount, 1);
    live.close();
    await waitFor(() => hub.detachCount === 1);
    assert.equal(hub.detachCount, 1);
  } finally {
    await host.close();
  }
});

test('wrong signer never reports ready and later timeout cannot detach twice', async () => {
  const { host, hub, pair } = fixture({ handshakeTimeoutMs: 80 });
  const other = generateKeyPairSync('ed25519');
  try {
    const { port } = await host.start();
    const connector = new WireConnector({
      endpoint: `ws://127.0.0.1:${port}/agent`,
      deviceId: 'device-1',
      capabilities: ['fs.v1'],
      signer: createEd25519Signer(other.privateKey),
      handshakeTimeoutMs: 80,
    });
    await assert.rejects(connector.connect());
    assert.equal(connector.isReady, false);
    await waitFor(() => hub.detachCount === 1);
    await delay(120);
    assert.equal(hub.attachCount, 1);
    assert.equal(hub.detachCount, 1);
    assert.equal(pair.publicKey.asymmetricKeyType, 'ed25519');
  } finally {
    await host.close();
  }
});

test('host close terminates WebSocket resources without hanging', async () => {
  const { host } = fixture();
  try {
    const { port } = await host.start();
    const client = await openClient(`ws://127.0.0.1:${port}/agent`);
    const closed = onceClose(client);
    await host.close();
    await closed;
    await host.close();
  } finally {
    await host.close();
  }
});

test('bufferedAmount ceiling closes 1013 and throws without sending', () => {
  const sent: string[] = [];
  const closes: Array<number | undefined> = [];
  const transport = new WireWsTransport({
    readyState: 1,
    bufferedAmount: DEFAULT_BUFFERED_AMOUNT_CEILING + 1,
    send(data: string) { sent.push(data); },
    close(code?: number) { closes.push(code); },
  });
  assert.throws(() => transport.send({ v: 'freerdc-wire/1', id: '1', kind: 'ping', ts: 1, payload: { type: 'ping' } }));
  assert.deepEqual(closes, [BACKPRESSURE_CLOSE_CODE]);
  assert.deepEqual(sent, []);
  transport.close(1000);
  assert.deepEqual(closes, [BACKPRESSURE_CLOSE_CODE]);
});
