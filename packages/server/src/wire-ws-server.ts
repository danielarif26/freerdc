import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateHostHeader,
  validateOriginHeader,
} from '@modelcontextprotocol/server';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import type { WireHub } from './wire-hub.js';
import {
  DEFAULT_BUFFERED_AMOUNT_CEILING,
  WIRE_WS_MAX_PAYLOAD,
  WireWsTransport,
} from './wire-ws-transport.js';

export const AGENT_UPGRADE_PATH = '/agent';
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const BINARY_CLOSE_CODE = 1003;
export const INVALID_PAYLOAD_CLOSE_CODE = 1007;
export const HANDSHAKE_TIMEOUT_CLOSE_CODE = 1008;

export interface AgentWebSocketServerOptions {
  handshakeTimeoutMs?: number;
  bufferedAmountCeiling?: number;
}

export interface AgentWebSocketServer {
  close(): Promise<void>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isExactAgentRequestTarget(url: string | undefined): boolean {
  return url === AGENT_UPGRADE_PATH;
}

function rejectUpgrade(socket: Duplex): void {
  try {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  } catch {
    // ignore write failures on a rejected upgrade
  }
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

export function decodeUtf8Text(data: RawData | string): string {
  if (typeof data === 'string') return data;
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function attachAgentWebSocketServer(
  httpServer: HttpServer,
  hub: WireHub,
  options: AgentWebSocketServerOptions = {},
): AgentWebSocketServer {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
    throw new TypeError('handshakeTimeoutMs must be a positive safe integer');
  }
  const bufferedAmountCeiling = options.bufferedAmountCeiling ?? DEFAULT_BUFFERED_AMOUNT_CEILING;
  const allowedHosts = localhostAllowedHostnames();
  const allowedOrigins = localhostAllowedOrigins();

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WIRE_WS_MAX_PAYLOAD,
    perMessageDeflate: false,
  });
  const connections = new Set<WebSocket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (closing || !isExactAgentRequestTarget(req.url)) {
      rejectUpgrade(socket);
      return;
    }
    if (!validateHostHeader(headerValue(req.headers.host), allowedHosts).ok) {
      rejectUpgrade(socket);
      return;
    }
    if (!validateOriginHeader(headerValue(req.headers.origin), allowedOrigins).ok) {
      rejectUpgrade(socket);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
      acceptConnection(ws);
    });
  };

  function acceptConnection(ws: WebSocket): void {
    if (closing) {
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    connections.add(ws);

    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionId: string | undefined;
    let settled = false;

    const clearHandshakeTimer = (): void => {
      if (handshakeTimer === undefined) return;
      clearTimeout(handshakeTimer);
      handshakeTimer = undefined;
    };

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearHandshakeTimer();
      connections.delete(ws);
      if (sessionId !== undefined) {
        try {
          hub.detach(sessionId);
        } catch {
          // detach is best-effort once settled
        }
      }
    };

    const transport = new WireWsTransport(ws, {
      bufferedAmountCeiling,
      onOutboundReady: clearHandshakeTimer,
    });

    try {
      sessionId = hub.attach(transport);
    } catch {
      connections.delete(ws);
      try { ws.close(1011); } catch { try { ws.terminate(); } catch { /* ignore */ } }
      return;
    }

    handshakeTimer = setTimeout(() => {
      handshakeTimer = undefined;
      try {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
          ws.close(HANDSHAKE_TIMEOUT_CLOSE_CODE);
        }
      } catch {
        // ignore
      }
      settle();
    }, handshakeTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (settled) return;
      if (isBinary === true) {
        try { ws.close(BINARY_CLOSE_CODE); } catch { /* ignore */ }
        settle();
        return;
      }
      try {
        const obj: unknown = JSON.parse(decodeUtf8Text(data));
        hub.receive(sessionId!, obj);
      } catch {
        try { ws.close(INVALID_PAYLOAD_CLOSE_CODE); } catch { /* ignore */ }
        settle();
      }
    });

    ws.on('close', () => {
      settle();
    });

    ws.on('error', () => {
      try { ws.terminate(); } catch { /* ignore */ }
      settle();
    });
  }

  httpServer.on('upgrade', onUpgrade);

  return {
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      httpServer.removeListener('upgrade', onUpgrade);
      closePromise = new Promise<void>((resolve) => {
        for (const ws of connections) {
          try { ws.close(); } catch { /* ignore */ }
          try { ws.terminate(); } catch { /* ignore */ }
        }
        connections.clear();
        wss.close(() => resolve());
      });
      return closePromise;
    },
  };
}
