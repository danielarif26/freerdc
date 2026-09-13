import { randomUUID } from 'node:crypto';

import type { ParsedEnvelope } from '@freerdc/protocol';

import type { WireConnector } from '../connector/wire-connector.js';
import {
  createRpcEnabledWireConnector,
  type RpcEnabledWireConnector,
  type RpcEnabledWireConnectorOptions,
} from './wire-runtime.js';

export interface ResilientWireTimer {
  cancel(): void;
}

export type ResilientWireTimerFactory = (callback: () => void, delayMs: number) => ResilientWireTimer;

export interface ResilientRpcWireAgentOptions
  extends Omit<RpcEnabledWireConnectorOptions, 'onFrame' | 'onDisconnected'> {
  onFrame?: (frame: ParsedEnvelope) => void;
  onDisconnected?: (error: Error) => void;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  reconnectMultiplier?: number;
  reconnectJitterRatio?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  random?: () => number;
  heartbeatNonceSource?: () => string;
  timerFactory?: ResilientWireTimerFactory;
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RECONNECT_MULTIPLIER = 2;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function defaultTimerFactory(callback: () => void, delayMs: number): ResilientWireTimer {
  const handle = setTimeout(callback, delayMs);
  return { cancel: () => clearTimeout(handle) };
}

export class ResilientRpcWireAgent {
  private readonly connectorOptions: Omit<RpcEnabledWireConnectorOptions, 'onFrame' | 'onDisconnected'>;
  private readonly onFrame?: (frame: ParsedEnvelope) => void;
  private readonly onDisconnected?: (error: Error) => void;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly reconnectMultiplier: number;
  private readonly reconnectJitterRatio: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly random: () => number;
  private readonly heartbeatNonceSource: () => string;
  private readonly timerFactory: ResilientWireTimerFactory;

  private running = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private active: RpcEnabledWireConnector | undefined;
  private reconnectTimer: ResilientWireTimer | undefined;
  private heartbeatTimer: ResilientWireTimer | undefined;
  private heartbeatDeadline: ResilientWireTimer | undefined;
  private pendingHeartbeatNonce: string | undefined;

  constructor(options: ResilientRpcWireAgentOptions) {
    const {
      onFrame,
      onDisconnected,
      initialReconnectDelayMs = DEFAULT_INITIAL_RECONNECT_DELAY_MS,
      maxReconnectDelayMs = DEFAULT_MAX_RECONNECT_DELAY_MS,
      reconnectMultiplier = DEFAULT_RECONNECT_MULTIPLIER,
      reconnectJitterRatio = DEFAULT_RECONNECT_JITTER_RATIO,
      heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
      random = Math.random,
      heartbeatNonceSource = randomUUID,
      timerFactory = defaultTimerFactory,
      ...connectorOptions
    } = options;

    this.initialReconnectDelayMs = positiveSafeInteger(initialReconnectDelayMs, 'initialReconnectDelayMs');
    this.maxReconnectDelayMs = positiveSafeInteger(maxReconnectDelayMs, 'maxReconnectDelayMs');
    if (this.maxReconnectDelayMs < this.initialReconnectDelayMs) {
      throw new TypeError('maxReconnectDelayMs must be greater than or equal to initialReconnectDelayMs');
    }
    if (!Number.isFinite(reconnectMultiplier) || reconnectMultiplier < 1) {
      throw new TypeError('reconnectMultiplier must be a finite number greater than or equal to 1');
    }
    if (!Number.isFinite(reconnectJitterRatio) || reconnectJitterRatio < 0 || reconnectJitterRatio > 1) {
      throw new TypeError('reconnectJitterRatio must be a finite number between 0 and 1');
    }
    this.heartbeatIntervalMs = positiveSafeInteger(heartbeatIntervalMs, 'heartbeatIntervalMs');
    this.heartbeatTimeoutMs = positiveSafeInteger(heartbeatTimeoutMs, 'heartbeatTimeoutMs');
    this.reconnectMultiplier = reconnectMultiplier;
    this.reconnectJitterRatio = reconnectJitterRatio;
    this.random = random;
    this.heartbeatNonceSource = heartbeatNonceSource;
    this.timerFactory = timerFactory;
    this.onFrame = onFrame;
    this.onDisconnected = onDisconnected;
    this.connectorOptions = connectorOptions;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get isReady(): boolean {
    return this.active?.connector.isReady ?? false;
  }

  get connector(): WireConnector | undefined {
    return this.active?.connector;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.reconnectAttempt = 0;
    this.connectFresh();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation += 1;
    this.cancelReconnect();
    this.cancelHeartbeat();
    const active = this.active;
    this.active = undefined;
    active?.connector.close();
  }

  private connectFresh(): void {
    if (!this.running) return;
    this.cancelReconnect();
    this.cancelHeartbeat();
    const generation = ++this.generation;

    const active = createRpcEnabledWireConnector({
      ...this.connectorOptions,
      onFrame: (frame) => this.handleFrame(generation, frame),
      onDisconnected: (error) => this.handleDisconnect(generation, error),
    });
    this.active = active;

    void active.connector.connect().then(() => {
      if (!this.isCurrent(generation, active)) {
        active.connector.close();
        return;
      }
      this.reconnectAttempt = 0;
      this.scheduleHeartbeat(generation);
    }).catch((error: unknown) => {
      if (!this.isCurrent(generation, active)) return;
      const normalized = error instanceof Error ? error : new Error('Wire connection failed');
      this.active = undefined;
      this.scheduleReconnect(normalized);
    });
  }

  private handleFrame(generation: number, frame: ParsedEnvelope): void {
    if (!this.running || generation !== this.generation) return;

    if (frame.status === 'known' && frame.kind === 'pong') {
      const pong = frame.frame as { nonce: string };
      if (this.pendingHeartbeatNonce !== undefined && pong.nonce === this.pendingHeartbeatNonce) {
        this.pendingHeartbeatNonce = undefined;
        this.heartbeatDeadline?.cancel();
        this.heartbeatDeadline = undefined;
        this.scheduleHeartbeat(generation);
      }
    }

    try {
      this.onFrame?.(frame);
    } catch {
      // Observers are informational. RPC dispatch remains isolated in wire-runtime.
    }
  }

  private handleDisconnect(generation: number, error: Error): void {
    if (!this.running || generation !== this.generation) return;
    this.active = undefined;
    this.cancelHeartbeat();
    try {
      this.onDisconnected?.(error);
    } catch {
      // Disconnect observers must never block recovery.
    }
    this.scheduleReconnect(error);
  }

  private scheduleHeartbeat(generation: number): void {
    if (!this.running || generation !== this.generation || !this.active?.connector.isReady) return;
    this.heartbeatTimer?.cancel();
    this.heartbeatTimer = this.timerFactory(() => {
      this.heartbeatTimer = undefined;
      if (!this.running || generation !== this.generation) return;
      const connector = this.active?.connector;
      if (!connector?.isReady) return;
      const nonce = this.heartbeatNonceSource();
      this.pendingHeartbeatNonce = nonce;
      try {
        connector.sendPing(nonce);
      } catch {
        connector.close();
        return;
      }
      this.heartbeatDeadline?.cancel();
      this.heartbeatDeadline = this.timerFactory(() => {
        this.heartbeatDeadline = undefined;
        if (!this.running || generation !== this.generation || this.pendingHeartbeatNonce !== nonce) return;
        this.pendingHeartbeatNonce = undefined;
        this.active?.connector.close();
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private scheduleReconnect(_error: Error): void {
    if (!this.running || this.reconnectTimer !== undefined) return;
    this.cancelHeartbeat();
    const base = Math.min(
      this.maxReconnectDelayMs,
      this.initialReconnectDelayMs * (this.reconnectMultiplier ** this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    const sample = this.random();
    const normalizedSample = Number.isFinite(sample) && sample >= 0 && sample <= 1 ? sample : 0.5;
    const jitter = base * this.reconnectJitterRatio * ((normalizedSample * 2) - 1);
    const delayMs = Math.max(0, Math.round(base + jitter));
    this.reconnectTimer = this.timerFactory(() => {
      this.reconnectTimer = undefined;
      this.connectFresh();
    }, delayMs);
  }

  private cancelReconnect(): void {
    this.reconnectTimer?.cancel();
    this.reconnectTimer = undefined;
  }

  private cancelHeartbeat(): void {
    this.heartbeatTimer?.cancel();
    this.heartbeatTimer = undefined;
    this.heartbeatDeadline?.cancel();
    this.heartbeatDeadline = undefined;
    this.pendingHeartbeatNonce = undefined;
  }

  private isCurrent(generation: number, active: RpcEnabledWireConnector): boolean {
    return this.running && generation === this.generation && this.active === active;
  }
}
