import { randomUUID } from 'node:crypto';

import {
  buildAgentAuthTranscript,
  parseEnvelope,
  WIRE_ID,
  WIRE_VERSION,
  type ParsedEnvelope,
} from '@freerdc/protocol';
import { WebSocket, type ClientOptions, type RawData } from 'ws';

export const WIRE_WS_MAX_PAYLOAD = 262_144;
export const DEFAULT_BUFFERED_AMOUNT_CEILING = 1_048_576;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const BACKPRESSURE_CLOSE_CODE = 1013;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ENVELOPE_VERSION = 'freerdc-wire/1';

export type AgentSigner = (transcript: Buffer) => Buffer | Promise<Buffer>;
export type WireConnectorWebSocketFactory = (url: string, options: ClientOptions) => WebSocket;

export interface WireConnectorOptions {
  endpoint: string;
  deviceId: string;
  capabilities?: readonly string[];
  signer: AgentSigner;
  handshakeTimeoutMs?: number;
  bufferedAmountCeiling?: number;
  onFrame?: (frame: ParsedEnvelope) => void;
  onDisconnected?: (error: Error) => void;
  webSocketFactory?: WireConnectorWebSocketFactory;
}

type HandshakeState = 'connecting' | 'awaiting-challenge' | 'awaiting-ready' | 'ready' | 'settled';

export function validateAgentEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError('Invalid agent endpoint URL');
  }
  if (url.protocol !== 'ws:') {
    throw new TypeError('Agent endpoint must use the ws: protocol');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Agent endpoint must not include credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('Agent endpoint must not include a query or fragment');
  }
  if (url.pathname !== '/agent') {
    throw new TypeError('Agent endpoint pathname must be exactly /agent');
  }
  // WHATWG hostname for IPv6 loopback is [::1] on this Node; [::1] is required by policy.
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new TypeError('Agent endpoint hostname must be loopback');
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError('Agent endpoint port must be 1 through 65535');
    }
  }
  return url;
}

function decodeUtf8Text(data: RawData | string): string {
  if (typeof data === 'string') return data;
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function toBase64Url(signature: Buffer | Uint8Array): string {
  return Buffer.isBuffer(signature) ? signature.toString('base64url') : Buffer.from(signature).toString('base64url');
}

export class WireConnector {
  readonly endpoint: string;
  private readonly deviceId: string;
  private readonly capabilities: readonly string[];
  private readonly signer: AgentSigner;
  private readonly handshakeTimeoutMs: number;
  private readonly ceiling: number;
  private readonly onFrame?: (frame: ParsedEnvelope) => void;
  private readonly onDisconnected?: (error: Error) => void;
  private readonly webSocketFactory: WireConnectorWebSocketFactory;

  private socket: WebSocket | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private state: HandshakeState = 'connecting';
  private ready = false;
  private connectPromise: Promise<void> | undefined;
  private resolveReady: (() => void) | undefined;
  private rejectReady: ((error: Error) => void) | undefined;
  private failure: Error | undefined;
  private wasReady = false;

  constructor(options: WireConnectorOptions) {
    validateAgentEndpoint(options.endpoint);
    this.endpoint = options.endpoint;
    if (typeof options.deviceId !== 'string' || options.deviceId.length === 0 || options.deviceId.length > 128) {
      throw new TypeError('deviceId must be a non-empty string of at most 128 characters');
    }
    this.deviceId = options.deviceId;
    this.capabilities = Object.freeze([...(options.capabilities ?? [])]);
    this.signer = options.signer;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.handshakeTimeoutMs) || this.handshakeTimeoutMs <= 0) {
      throw new TypeError('handshakeTimeoutMs must be a positive safe integer');
    }
    this.ceiling = options.bufferedAmountCeiling ?? DEFAULT_BUFFERED_AMOUNT_CEILING;
    if (!Number.isSafeInteger(this.ceiling) || this.ceiling <= 0) {
      throw new TypeError('bufferedAmountCeiling must be a positive safe integer');
    }
    this.onFrame = options.onFrame;
    this.onDisconnected = options.onDisconnected;
    this.webSocketFactory = options.webSocketFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
  }

  get isReady(): boolean {
    return this.ready && this.state === 'ready';
  }

  connect(): Promise<void> {
    if (this.connectPromise !== undefined) return this.connectPromise;
    if (this.state === 'settled') {
      return Promise.reject(this.failure ?? new Error('Connector is closed'));
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      const socket = this.webSocketFactory(this.endpoint, {
        maxPayload: WIRE_WS_MAX_PAYLOAD,
        perMessageDeflate: false,
      });
      this.socket = socket;
      this.armHandshakeTimeout();

      socket.on('open', () => {
        if (this.state === 'settled') return;
        try {
          this.sendFrame('hello', {
            type: 'hello',
            wireId: WIRE_ID,
            deviceId: this.deviceId,
            version: WIRE_VERSION,
            capabilities: [...this.capabilities],
          });
          this.state = 'awaiting-challenge';
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error('Failed to send hello'));
        }
      });

      socket.on('message', (data, isBinary) => {
        void this.handleMessage(data, isBinary);
      });

      socket.on('close', () => {
        this.fail(new Error('WebSocket closed'));
      });

      socket.on('error', (error) => {
        this.fail(error);
      });
    });

    return this.connectPromise;
  }

  close(): void {
    this.fail(new Error('Connector closed'));
  }

  sendPing(nonce: string): void {
    if (!this.isReady) {
      throw new Error('WireConnector is not ready');
    }
    if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 128 || /[\x00-\x1f\x7f]/.test(nonce)) {
      throw new TypeError('nonce must be 1 to 128 printable characters');
    }
    this.sendFrame('ping', { type: 'ping', nonce });
  }

  sendRpcResult(requestId: string, result: unknown): void {
    if (!this.isReady) {
      throw new Error('WireConnector is not ready');
    }
    this.sendFrame('rpc.res', { type: 'rpc.res', requestId, result });
  }

  sendRpcError(requestId: string, error: { code: string }): void {
    if (!this.isReady) {
      throw new Error('WireConnector is not ready');
    }
    this.sendFrame('rpc.err', { type: 'rpc.err', requestId, error: { code: error.code } });
  }

  private isSettled(): boolean {
    return this.state === 'settled';
  }

  private armHandshakeTimeout(): void {
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined;
      this.fail(new Error('Agent handshake timed out'));
    }, this.handshakeTimeoutMs);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === undefined) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private async handleMessage(data: RawData, isBinary: boolean): Promise<void> {
    if (this.state === 'settled') return;
    if (isBinary === true) {
      this.fail(new Error('Binary WebSocket frames are not allowed'));
      return;
    }

    let parsed: ParsedEnvelope;
    try {
      parsed = parseEnvelope(JSON.parse(decodeUtf8Text(data)));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Malformed wire frame'));
      return;
    }

    if (this.state === 'ready') {
      try {
        this.onFrame?.(parsed);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Frame handler failed'));
      }
      return;
    }

    if (this.state === 'awaiting-challenge') {
      if (parsed.status !== 'known' || parsed.kind !== 'challenge') {
        this.fail(new Error('Unexpected handshake frame'));
        return;
      }
      this.state = 'awaiting-ready';
      const nonce = (parsed.frame as { nonce: string }).nonce;
      try {
        const signature = await this.signer(buildAgentAuthTranscript(this.deviceId, nonce));
        if (this.isSettled()) return;
        this.sendFrame('auth', {
          type: 'auth',
          wireId: WIRE_ID,
          signature: toBase64Url(signature),
        });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Authentication failed'));
      }
      return;
    }

    if (this.state === 'awaiting-ready') {
      if (parsed.status !== 'known' || parsed.kind !== 'ready') {
        this.fail(new Error('Unexpected handshake frame'));
        return;
      }
      this.markReady();
      return;
    }

    this.fail(new Error('Unexpected handshake frame'));
  }

  private markReady(): void {
    if (this.state === 'settled') return;
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      this.fail(new Error('Socket closed before ready'));
      return;
    }
    this.clearHandshakeTimer();
    this.state = 'ready';
    this.ready = true;
    this.wasReady = true;
    this.resolveReady?.();
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }

  private sendFrame(kind: string, payload: unknown): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open');
    }
    if (socket.bufferedAmount > this.ceiling) {
      try { socket.close(BACKPRESSURE_CLOSE_CODE); } catch { /* ignore */ }
      throw new Error('WebSocket backpressure limit exceeded');
    }
    socket.send(JSON.stringify({
      v: ENVELOPE_VERSION,
      id: randomUUID(),
      kind,
      ts: Date.now(),
      payload,
    }));
  }

  private fail(error: Error): void {
    if (this.state === 'settled') return;
    const pending = this.state !== 'ready';
    const notifyDisconnected = this.wasReady;
    this.state = 'settled';
    this.ready = false;
    this.failure = error;
    this.clearHandshakeTimer();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close();
      } catch {
        try { socket.terminate(); } catch { /* ignore */ }
      }
    }
    if (pending) this.rejectReady?.(error);
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    if (notifyDisconnected) {
      try {
        this.onDisconnected?.(error);
      } catch {
        // Disconnect observers are informational and must never escape cleanup.
      }
    }
  }
}
