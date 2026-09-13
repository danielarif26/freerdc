import { WireTransport } from './wire-hub.js';

export const WIRE_WS_MAX_PAYLOAD = 262_144;
export const DEFAULT_BUFFERED_AMOUNT_CEILING = 1_048_576;
export const BACKPRESSURE_CLOSE_CODE = 1013;
const DEFAULT_OPEN_STATE = 1;

/** Minimal send/close surface used by the WebSocket wire transport. */
export interface WireSendSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number): void;
}

export interface WireWsTransportOptions {
  bufferedAmountCeiling?: number;
  onOutboundReady?: () => void;
  openState?: number;
}

function isReadyEnvelope(frame: unknown): boolean {
  return Boolean(
    frame
    && typeof frame === 'object'
    && 'kind' in frame
    && (frame as { kind: unknown }).kind === 'ready',
  );
}

/**
 * Adapts a WebSocket-like socket to {@link WireTransport}.
 * Observing an outbound protocol `ready` envelope clears only the handshake timer.
 */
export class WireWsTransport extends WireTransport {
  private closed = false;
  private readonly ceiling: number;
  private readonly openState: number;

  constructor(
    private readonly socket: WireSendSocket,
    private readonly options: WireWsTransportOptions = {},
  ) {
    super();
    const ceiling = options.bufferedAmountCeiling ?? DEFAULT_BUFFERED_AMOUNT_CEILING;
    if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
      throw new TypeError('bufferedAmountCeiling must be a positive safe integer');
    }
    this.ceiling = ceiling;
    this.openState = options.openState ?? DEFAULT_OPEN_STATE;
  }

  override send(frame: unknown): void {
    if (this.closed || this.socket.readyState !== this.openState) {
      throw new Error('WebSocket is not open');
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(frame);
    } catch (error) {
      throw error instanceof Error ? error : new Error('WebSocket frame serialization failed');
    }
    if (this.socket.bufferedAmount > this.ceiling) {
      this.close(BACKPRESSURE_CLOSE_CODE);
      throw new Error('WebSocket backpressure limit exceeded');
    }
    try {
      this.socket.send(serialized);
    } catch (error) {
      throw error instanceof Error ? error : new Error('WebSocket send failed');
    }
    if (isReadyEnvelope(frame)) {
      this.options.onOutboundReady?.();
    }
  }

  override close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (code === undefined) this.socket.close();
      else this.socket.close(code);
    } catch {
      // Close is best-effort and must stay idempotent.
    }
  }
}
