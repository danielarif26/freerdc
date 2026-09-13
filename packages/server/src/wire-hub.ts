import { randomBytes, randomUUID, verify, type KeyObject } from 'node:crypto';

import {
  buildAgentAuthTranscript,
  negotiate,
  parseEnvelope,
  WIRE_ID,
  WIRE_VERSION,
  type WireVersion,
  ERROR_CODES,
  E_CONCURRENCY_LIMIT,
  E_DEVICE_OFFLINE,
  E_INTERNAL,
  E_TIMEOUT,
  FreeRdcError,
} from '@freerdc/protocol';

import { DeviceRegistry } from './device-registry.js';

const DEFAULT_CAPABILITIES = ['fs.v1', 'search.v1', 'pty.pipe.v1', 'proc.v1', 'dryrun.v1'];
const FAILURE_CLOSE_CODE = 1008;
const SUPERSEDED_CLOSE_CODE = 1012;
const DEFAULT_SESSION_SUPERSEDE_COOLDOWN_MS = 5_000;

export abstract class WireTransport {
  abstract send(frame: unknown): void;
  abstract close(code?: number): void;
}

export interface WireHubOptions {
  registry: DeviceRegistry;
  authorizedKeys: ReadonlyMap<string, KeyObject>;
  supportedCapabilities?: readonly string[];
  nonceSource?: () => Buffer;
  clock?: () => Date;
  sessionIdSource?: () => string;
  requestTimeoutMs?: number;
  maxPendingPerDevice?: number;
  requestIdSource?: () => string;
  sessionSupersedeCooldownMs?: number;
  onSessionSuperseded?: (deviceId: string) => void;
}

type SessionState = 'awaiting-hello' | 'awaiting-auth' | 'ready' | 'closed';

interface Session {
  transport: WireTransport;
  state: SessionState;
  closed: boolean;
  deviceId?: string;
  nonce?: string;
  version?: WireVersion;
  capabilities?: readonly string[];
  pending: Map<string, PendingRequest>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: FreeRdcError) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * In-memory, transport-agnostic server half of the authenticated wire handshake.
 * Auth signatures must be canonical RFC 4648 base64url without padding.
 */
export class WireHub {
  private readonly sessions = new Map<string, Session>();
  private readonly supportedCapabilities: readonly string[];
  private readonly nonceSource: () => Buffer;
  private readonly clock: () => Date;
  private readonly sessionIdSource: () => string;
  private readonly requestTimeoutMs: number;
  private readonly maxPendingPerDevice: number;
  private readonly requestIdSource: () => string;
  private readonly sessionSupersedeCooldownMs: number;
  private readonly deviceSessions = new Map<string, string>();
  private readonly lastSessionSupersedeAt = new Map<string, number>();

  constructor(private readonly options: WireHubOptions) {
    for (const key of options.authorizedKeys.values()) {
      if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
        throw new TypeError('Authorized keys must be public Ed25519 keys');
      }
    }
    this.supportedCapabilities = Object.freeze([...(options.supportedCapabilities ?? DEFAULT_CAPABILITIES)]);
    this.nonceSource = options.nonceSource ?? (() => randomBytes(32));
    this.clock = options.clock ?? (() => new Date());
    this.sessionIdSource = options.sessionIdSource ?? randomUUID;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxPendingPerDevice = options.maxPendingPerDevice ?? 32;
    this.requestIdSource = options.requestIdSource ?? randomUUID;
    this.sessionSupersedeCooldownMs = options.sessionSupersedeCooldownMs ?? DEFAULT_SESSION_SUPERSEDE_COOLDOWN_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxPendingPerDevice) || this.maxPendingPerDevice <= 0) {
      throw new TypeError('maxPendingPerDevice must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.sessionSupersedeCooldownMs) || this.sessionSupersedeCooldownMs < 0) {
      throw new TypeError('sessionSupersedeCooldownMs must be a non-negative safe integer');
    }
  }

  attach(transport: WireTransport): string {
    const sessionId = this.sessionIdSource();
    if (typeof sessionId !== 'string' || sessionId.length === 0 || this.sessions.has(sessionId)) {
      throw new Error('Unable to create wire session');
    }
    this.sessions.set(sessionId, { transport, state: 'awaiting-hello', closed: false, pending: new Map() });
    return sessionId;
  }

  async request(deviceId: string, method: string, params?: unknown): Promise<unknown> {
    if (!this.isSafeDeviceId(deviceId) || !this.isSafeMethod(method)) {
      throw new FreeRdcError(E_DEVICE_OFFLINE);
    }
    const sessionId = this.deviceSessions.get(deviceId);
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    if (!session || session.closed || session.state !== 'ready' || session.deviceId !== deviceId) {
      throw new FreeRdcError(E_DEVICE_OFFLINE);
    }
    if (session.pending.size >= this.maxPendingPerDevice) throw new FreeRdcError(E_CONCURRENCY_LIMIT);
    const requestId = this.requestIdSource();
    if (typeof requestId !== 'string' || requestId.length === 0 || session.pending.has(requestId)) {
      throw new FreeRdcError(E_INTERNAL);
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = session.pending.get(requestId);
        if (!pending) return;
        session.pending.delete(requestId);
        try {
          this.send(session, 'cancel', { type: 'cancel', requestId });
        } catch {
          this.fail(session);
        }
        reject(new FreeRdcError(E_TIMEOUT));
      }, this.requestTimeoutMs);
      session.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.send(session, 'rpc.req', params === undefined
          ? { type: 'rpc.req', requestId, method }
          : { type: 'rpc.req', requestId, method, params });
      } catch {
        this.fail(session);
      }
    });
  }

  receive(sessionId: string, input: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;

    let parsed: ReturnType<typeof parseEnvelope>;
    try {
      parsed = parseEnvelope(input);
    } catch {
      this.fail(session);
      return;
    }

    if (session.state === 'awaiting-hello') {
      if (parsed.status !== 'known' || parsed.kind !== 'hello') return this.fail(session);
      const hello = parsed.frame as { deviceId?: string; wireId: string; version: WireVersion; capabilities?: string[] };
      if (!hello.deviceId || hello.wireId !== WIRE_ID || !this.options.authorizedKeys.has(hello.deviceId)) {
        return this.fail(session);
      }
      const result = negotiate(
        { version: WIRE_VERSION, supported: [...this.supportedCapabilities] },
        { version: hello.version, supported: hello.capabilities ?? [] },
      );
      if (!result.ok) return this.fail(session);

      let nonce: Buffer;
      try {
        nonce = this.nonceSource();
      } catch {
        return this.fail(session);
      }
      if (!Buffer.isBuffer(nonce) || nonce.length === 0) return this.fail(session);
      session.deviceId = hello.deviceId;
      session.nonce = nonce.toString('base64url');
      session.version = result.version;
      session.capabilities = Object.freeze([...result.capabilities]);
      session.state = 'awaiting-auth';
      try {
        this.send(session, 'challenge', { type: 'challenge', nonce: session.nonce });
      } catch {
        this.fail(session);
      }
      return;
    }

    if (session.state === 'awaiting-auth') {
      if (parsed.status !== 'known' || parsed.kind !== 'auth' || parsed.frame.wireId !== WIRE_ID) {
        return this.fail(session);
      }
      const key = session.deviceId === undefined ? undefined : this.options.authorizedKeys.get(session.deviceId);
      const signature = this.decodeCanonicalBase64Url((parsed.frame as { signature: string }).signature);
      if (!key || !signature || !session.deviceId || !session.nonce) return this.fail(session);
      let authenticated = false;
      try {
        authenticated = verify(null, buildAgentAuthTranscript(session.deviceId, session.nonce), key, signature);
      } catch {
        // Treat crypto and transcript errors exactly like an authentication failure.
      }
      if (!authenticated) return this.fail(session);

      // Authentication has succeeded, so a fresh connection for the same device
      // may safely supersede a stale/half-open prior transport. This prevents an
      // old TCP session from blocking recovery indefinitely.
      const priorSessionId = this.deviceSessions.get(session.deviceId);
      if (priorSessionId !== undefined && priorSessionId !== sessionId) {
        const priorSession = this.sessions.get(priorSessionId);
        if (priorSession !== undefined && !priorSession.closed) {
          const now = this.clock().getTime();
          const lastSupersede = this.lastSessionSupersedeAt.get(session.deviceId);
          if (lastSupersede !== undefined && now >= lastSupersede && now - lastSupersede < this.sessionSupersedeCooldownMs) {
            return this.fail(session);
          }
          this.closeSession(priorSession, SUPERSEDED_CLOSE_CODE);
          this.lastSessionSupersedeAt.set(session.deviceId, now);
          try {
            this.options.onSessionSuperseded?.(session.deviceId);
          } catch {
            // Observability must never affect authenticated session recovery.
          }
        }
      }
      const existing = this.options.registry.get(session.deviceId);
      try {
        if (existing) this.options.registry.heartbeat(session.deviceId);
        else this.options.registry.register({ id: session.deviceId, capabilities: session.capabilities ?? [] });
      } catch {
        return this.fail(session);
      }
      session.state = 'ready';
      this.deviceSessions.set(session.deviceId, sessionId);
      try {
        this.send(session, 'ready', {
          type: 'ready', version: session.version, capabilities: session.capabilities,
        });
      } catch {
        this.fail(session);
      }
      return;
    }

    if (session.state === 'ready' && parsed.status === 'known') {
      if (parsed.kind === 'ping') {
        this.heartbeat(session);
        try {
          this.send(session, 'pong', { type: 'pong', nonce: parsed.frame.nonce });
        } catch {
          this.fail(session);
        }
      } else if (parsed.kind === 'pong') {
        this.heartbeat(session);
      } else if (parsed.kind === 'rpc.res') {
        const frame = parsed.frame as { requestId: string; result: unknown };
        this.resolvePending(session, frame.requestId, frame.result);
      } else if (parsed.kind === 'rpc.err') {
        const frame = parsed.frame as { requestId: string; error: unknown };
        this.rejectPending(session, frame.requestId, this.rpcErrorCode(frame.error));
      }
    }
  }

  detach(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    this.closeSession(session, undefined);
  }

  private heartbeat(session: Session): void {
    if (session.deviceId) this.options.registry.heartbeat(session.deviceId);
  }

  private send(session: Session, kind: string, payload: unknown): void {
    session.transport.send({ v: 'freerdc-wire/1', id: randomUUID(), kind, ts: this.clock().getTime(), payload });
  }

  private fail(session: Session): void {
    if (session.closed) return;
    this.closeSession(session, FAILURE_CLOSE_CODE);
  }

  private closeSession(session: Session, code: number | undefined): void {
    const sessionId = [...this.sessions.entries()].find(([, candidate]) => candidate === session)?.[0];
    const ownsDevice = session.state === 'ready' && session.deviceId !== undefined
      && sessionId !== undefined && this.deviceSessions.get(session.deviceId) === sessionId;
    session.state = 'closed';
    session.closed = true;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new FreeRdcError(E_DEVICE_OFFLINE));
    }
    session.pending.clear();
    if (ownsDevice) {
      this.deviceSessions.delete(session.deviceId!);
      this.options.registry.markOffline(session.deviceId!);
    }
    if (sessionId !== undefined) this.sessions.delete(sessionId);
    try {
      session.transport.close(code);
    } catch {
      // Transport failures cannot undo local cleanup or disrupt promise settlement.
    }
  }

  private resolvePending(session: Session, requestId: string, result: unknown): void {
    const pending = session.pending.get(requestId);
    if (!pending) return;
    session.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  private rejectPending(session: Session, requestId: string, code: typeof ERROR_CODES[keyof typeof ERROR_CODES]): void {
    const pending = session.pending.get(requestId);
    if (!pending) return;
    session.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.reject(new FreeRdcError(code));
  }

  private rpcErrorCode(error: unknown): typeof ERROR_CODES[keyof typeof ERROR_CODES] {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      && Object.values(ERROR_CODES).includes(error.code as typeof ERROR_CODES[keyof typeof ERROR_CODES])) {
      return error.code as typeof ERROR_CODES[keyof typeof ERROR_CODES];
    }
    return E_INTERNAL;
  }

  private isSafeDeviceId(value: string): boolean {
    return value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
  }

  private isSafeMethod(value: string): boolean {
    return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
  }

  private decodeCanonicalBase64Url(value: string): Buffer | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
    try {
      const decoded = Buffer.from(value, 'base64url');
      return decoded.length > 0 && decoded.toString('base64url') === value ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
}
