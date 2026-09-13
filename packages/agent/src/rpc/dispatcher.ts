import {
  E_CAPABILITY_UNSUPPORTED,
  E_CONCURRENCY_LIMIT,
  E_DEVICE_OFFLINE,
  E_INTERNAL,
  E_MALFORMED_MESSAGE,
  ERROR_CODES,
  FreeRdcError,
  type RpcMethod,
  isRpcMethod,
  parseRpcParams,
  type ParsedEnvelope,
  CANCEL_FRAME,
  RPC_REQ_FRAME,
} from '@freerdc/protocol';
import { SafeFilesystem } from '../filesystem.js';
import { ProcessManager, type ProcessReadResult } from '../process-manager.js';
import { encodeWireBytes, decodeWireBytes } from './encoding.js';

export interface RpcErrorWire {
  code: string;
}

export interface RpcResponder {
  sendResult(requestId: string, result: unknown): void;
  sendError(requestId: string, error: RpcErrorWire): void;
}

export interface RpcDispatcherOptions {
  filesystem: SafeFilesystem;
  processManager?: ProcessManager;
  responder: RpcResponder;
  maxInFlight?: number;
}

interface ActiveEntry {
  cancelled: boolean;
  settled: boolean;
  abortController?: AbortController;
}

const VALID_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));
const MAX_WIRE_PROCESS_READ_BYTES = 32 * 1024;

export class RpcDispatcher {
  readonly #filesystem: SafeFilesystem;
  readonly #processManager: ProcessManager | undefined;
  readonly #responder: RpcResponder;
  readonly #maxInFlight: number;
  readonly #active = new Map<string, ActiveEntry>();

  constructor(options: RpcDispatcherOptions) {
    this.#filesystem = options.filesystem;
    this.#processManager = options.processManager;
    this.#responder = options.responder;
    const maxInFlight = options.maxInFlight ?? 16;
    if (!Number.isSafeInteger(maxInFlight) || maxInFlight <= 0) {
      throw new TypeError('maxInFlight must be a positive safe integer');
    }
    this.#maxInFlight = maxInFlight;
  }

  handleFrame(frame: ParsedEnvelope): void {
    if (frame.status !== 'known') {
      return;
    }

    const { kind, frame: innerFrame } = frame;

    if (kind === 'cancel') {
      const cancelResult = CANCEL_FRAME.safeParse(innerFrame);
      if (!cancelResult.success) {
        return;
      }
      const { requestId } = cancelResult.data;
      this.#handleCancel(requestId);
      return;
    }

    if (kind !== 'rpc.req') {
      return;
    }

    const reqResult = RPC_REQ_FRAME.safeParse(innerFrame);
    if (!reqResult.success) {
      return;
    }
    const { requestId, method, params } = reqResult.data;
    this.#handleRequest(requestId, method, params);
  }

  #handleCancel(requestId: string): void {
    const entry = this.#active.get(requestId);
    if (entry && !entry.settled) {
      entry.cancelled = true;
      entry.abortController?.abort();
    }
  }

  #handleRequest(requestId: string, method: string, params: unknown): void {
    if (requestId.length < 1 || requestId.length > 128) {
      return;
    }

    // A live (unsettled) requestId is always still present in #active, since
    // settling and removal from #active happen atomically everywhere else in
    // this class. A duplicate against a live request must not emit any frame
    // and must not disturb the original in-flight request.
    if (this.#active.has(requestId)) {
      return;
    }

    if (!isRpcMethod(method)) {
      this.#safeSendError(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
      return;
    }

    if (this.#active.size >= this.#maxInFlight) {
      this.#safeSendError(requestId, new FreeRdcError(E_CONCURRENCY_LIMIT));
      return;
    }

    const entry: ActiveEntry = { cancelled: false, settled: false };
    this.#active.set(requestId, entry);

    void this.#runRequest(requestId, method, params);
  }

  async #runRequest(requestId: string, method: RpcMethod, params: unknown): Promise<void> {
    const entry = this.#active.get(requestId);
    if (!entry) {
      return;
    }

    try {
      let parsedParams: unknown;
      try {
        parsedParams = parseRpcParams(method, params ?? {});
      } catch {
        this.#finish(requestId, new FreeRdcError(E_MALFORMED_MESSAGE));
        return;
      }

      if (entry.cancelled) {
        entry.settled = true;
        this.#active.delete(requestId);
        return;
      }

      let result: unknown;

      switch (method) {
        case 'fs.stat': {
          const p = parsedParams as { path: string };
          result = this.#filesystem.stat(p.path);
          break;
        }
        case 'fs.list': {
          const p = parsedParams as { path: string };
          result = this.#filesystem.list(p.path);
          break;
        }
        case 'fs.read': {
          const p = parsedParams as { path: string };
          const buffer = this.#filesystem.read(p.path);
          result = { content: encodeWireBytes(buffer) };
          break;
        }
        case 'fs.search': {
          const p = parsedParams as { path: string; query: string; caseSensitive?: boolean; maxDepth?: number };
          result = this.#filesystem.search(p.path, p.query, { caseSensitive: p.caseSensitive, maxDepth: p.maxDepth });
          break;
        }
        case 'fs.mkdir': {
          const p = parsedParams as { path: string; dryRun?: 'off' | 'plan' };
          result = this.#filesystem.mkdir(p.path, { dryRun: p.dryRun });
          break;
        }
        case 'fs.write': {
          const p = parsedParams as { path: string; content: { encoding: 'utf8' | 'base64'; data: string }; expectedSha256?: string; dryRun?: 'off' | 'plan' };
          const content = decodeWireBytes(p.content);
          result = this.#filesystem.write(p.path, content, { expectedSha256: p.expectedSha256, dryRun: p.dryRun });
          break;
        }
        case 'fs.delete': {
          const p = parsedParams as { path: string; expectedSha256: string; dryRun?: 'off' | 'plan' };
          result = this.#filesystem.deleteFile(p.path, { expectedSha256: p.expectedSha256, dryRun: p.dryRun });
          break;
        }
        case 'fs.move': {
          const p = parsedParams as { source: string; destination: string; expectedSha256: string; dryRun?: 'off' | 'plan' };
          result = this.#filesystem.moveFile(p.source, p.destination, { expectedSha256: p.expectedSha256, dryRun: p.dryRun });
          break;
        }
        case 'proc.start': {
          if (!this.#processManager) {
            this.#finish(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
            return;
          }
          const p = parsedParams as { executable: string; argv: string[]; cwd?: string; timeoutMs?: number; dryRun?: 'off' | 'plan' };
          const abortController = new AbortController();
          entry.abortController = abortController;
          result = await this.#processManager.start({
            executable: p.executable,
            argv: p.argv,
            cwd: p.cwd,
            timeoutMs: p.timeoutMs,
            dryRun: p.dryRun,
          }, { signal: abortController.signal });
          break;
        }
        case 'proc.read': {
          if (!this.#processManager) {
            this.#finish(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
            return;
          }
          const p = parsedParams as { id: string };
          const pmResult = this.#processManager.read(p.id, MAX_WIRE_PROCESS_READ_BYTES);
          if (!pmResult) {
            this.#finish(requestId, new FreeRdcError(E_DEVICE_OFFLINE));
            return;
          }
          result = {
            stdout: encodeWireBytes(pmResult.stdout),
            stderr: encodeWireBytes(pmResult.stderr),
            truncated: pmResult.truncated,
            hasMore: pmResult.hasMore,
            status: pmResult.status,
            exitCode: pmResult.exitCode,
            signal: pmResult.signal,
          };
          break;
        }
        case 'proc.input': {
          if (!this.#processManager) {
            this.#finish(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
            return;
          }
          const p = parsedParams as { id: string; data: { encoding: 'utf8' | 'base64'; data: string } };
          const data = decodeWireBytes(p.data);
          const accepted = this.#processManager.input(p.id, data);
          if (!accepted) {
            this.#finish(requestId, new FreeRdcError(E_DEVICE_OFFLINE));
            return;
          }
          result = { accepted: true };
          break;
        }
        case 'proc.kill': {
          if (!this.#processManager) {
            this.#finish(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
            return;
          }
          const p = parsedParams as { id: string; force: boolean };
          const killed = this.#processManager.kill(p.id, p.force);
          if (!killed) {
            this.#finish(requestId, new FreeRdcError(E_DEVICE_OFFLINE));
            return;
          }
          result = { killed: true };
          break;
        }
        case 'proc.list': {
          if (!this.#processManager) {
            this.#finish(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
            return;
          }
          result = { processes: this.#processManager.list() };
          break;
        }
        default: {
          this.#finish(requestId, new FreeRdcError(E_CAPABILITY_UNSUPPORTED));
          return;
        }
      }

      if (entry.cancelled) {
        entry.settled = true;
        this.#active.delete(requestId);
        return;
      }

      this.#safeSendResult(requestId, result);
    } catch (error) {
      this.#finish(requestId, error);
      return;
    } finally {
      if (!entry.cancelled && !entry.settled) {
        entry.settled = true;
        this.#active.delete(requestId);
      }
    }
  }

  #finish(requestId: string, error: unknown): void {
    const entry = this.#active.get(requestId);
    if (!entry) {
      return;
    }
    entry.settled = true;
    this.#active.delete(requestId);

    if (entry.cancelled) {
      return;
    }

    if (error instanceof FreeRdcError) {
      this.#safeSendError(requestId, error);
    } else {
      this.#safeSendError(requestId, new FreeRdcError(E_INTERNAL));
    }
  }

  #safeSendResult(requestId: string, result: unknown): void {
    try {
      this.#responder.sendResult(requestId, result);
    } catch {
      // Ignore responder errors
    }
  }

  #safeSendError(requestId: string, error: FreeRdcError): void {
    // error.code is typed as ErrorCode, but a runtime-forged or otherwise
    // noncanonical value could still reach here (e.g. via a misbehaving
    // subclass or property override). Only values from the protocol's
    // ERROR_CODES may ever be sent over the wire.
    const code = VALID_ERROR_CODES.has(error.code) ? error.code : E_INTERNAL;
    try {
      this.#responder.sendError(requestId, { code });
    } catch {
      // Ignore responder errors
    }
  }
}
