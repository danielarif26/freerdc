import type { ParsedEnvelope } from '@freerdc/protocol';

import { WireConnector, type WireConnectorOptions } from '../connector/wire-connector.js';
import type { SafeFilesystem } from '../filesystem.js';
import type { ProcessManager } from '../process-manager.js';
import { RpcDispatcher, type RpcErrorWire, type RpcResponder } from './dispatcher.js';

export interface RpcEnabledWireConnectorRpcOptions {
  filesystem: SafeFilesystem;
  processManager?: ProcessManager;
  maxInFlight?: number;
}

export interface RpcEnabledWireConnectorOptions extends WireConnectorOptions {
  rpc: RpcEnabledWireConnectorRpcOptions;
  onRpcTransportError?: (error: unknown) => void;
}

export interface RpcEnabledWireConnector {
  connector: WireConnector;
  dispatcher: RpcDispatcher;
}

export function createRpcEnabledWireConnector(
  options: RpcEnabledWireConnectorOptions,
): RpcEnabledWireConnector {
  const { rpc, onRpcTransportError, onFrame: originalOnFrame, ...connectorOptions } = options;

  const reportTransportError = (error: unknown): void => {
    try {
      onRpcTransportError?.(error);
    } catch {
      // The caller's error callback must never be allowed to escape.
    }
  };

  // `dispatcher` is assigned below, after `connector` exists (RpcDispatcher's
  // responder needs to call back into `connector`). `wrappedOnFrame` only
  // runs on a later WebSocket message event, by which time both are set.
  let dispatcher: RpcDispatcher | undefined;

  const wrappedOnFrame = (frame: ParsedEnvelope): void => {
    try {
      originalOnFrame?.(frame);
    } catch (error) {
      reportTransportError(error);
    }

    if (frame.status !== 'known') return;
    if (frame.kind !== 'rpc.req' && frame.kind !== 'cancel') return;
    if (!connector.isReady) return;

    dispatcher?.handleFrame(frame);
  };

  const connector = new WireConnector({
    ...connectorOptions,
    onFrame: wrappedOnFrame,
  });

  const responder: RpcResponder = {
    sendResult(requestId: string, result: unknown): void {
      try {
        connector.sendRpcResult(requestId, result);
      } catch (error) {
        reportTransportError(error);
        connector.close();
      }
    },
    sendError(requestId: string, error: RpcErrorWire): void {
      try {
        connector.sendRpcError(requestId, error);
      } catch (err) {
        reportTransportError(err);
        connector.close();
      }
    },
  };

  dispatcher = new RpcDispatcher({
    filesystem: rpc.filesystem,
    processManager: rpc.processManager,
    responder,
    maxInFlight: rpc.maxInFlight,
  });

  return { connector, dispatcher };
}
