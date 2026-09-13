import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServerFactory } from "@modelcontextprotocol/server";

import type { WireHub } from "./wire-hub.js";
import { attachAgentWebSocketServer, type AgentWebSocketServer } from "./wire-ws-server.js";
import { MCP_ACCESS_SCOPE, type OAuthProvider } from "./oauth.js";

export const LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 8787;

export interface McpHttpAddress {
  host: typeof LOOPBACK_HOST;
  port: number;
}

export interface LoopbackMcpHttpHostOptions {
  hub?: WireHub;
  handshakeTimeoutMs?: number;
  bufferedAmountCeiling?: number;
  oauth?: OAuthProvider;
}

/** A loopback-only Node HTTP boundary for an MCP server factory. */
export class LoopbackMcpHttpHost {
  private server: Server | undefined;
  private startPromise: Promise<McpHttpAddress> | undefined;
  private closePromise: Promise<void> | undefined;
  private listening = false;
  private wireWs: AgentWebSocketServer | undefined;
  private readonly oauth: OAuthProvider | undefined;

  public constructor(
    factory: McpServerFactory,
    private readonly port: number = DEFAULT_MCP_HTTP_PORT,
    options: LoopbackMcpHttpHostOptions = {},
  ) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new RangeError("port must be an integer from 0 through 65535");
    }

    const mcpHandler = toNodeHandler(createMcpHandler(factory));
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    this.oauth = options.oauth;
    const oauth = this.oauth;

    this.server = createServer((request, response) => {
      // Asterisk-form OPTIONS applies to the server as a whole. Handle it
      // directly so it cannot be interpreted as an MCP request target.
      if (request.method === "OPTIONS" && request.url === "*") {
        request.resume();
        response.statusCode = 204;
        response.setHeader("content-length", "0");
        response.end();
        return;
      }
      let pathname: string | undefined;
      if (request.url !== undefined) {
        // Only HTTP origin-form request targets are accepted. Absolute-form and
        // protocol-relative targets can otherwise collapse onto a recognized
        // pathname while carrying a different authority.
        if (!request.url.startsWith("/") || request.url.startsWith("//")) {
          request.resume();
          response.statusCode = 400;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.setHeader("connection", "close");
          response.end("Bad Request");
          return;
        }
        try {
          pathname = new URL(request.url, "http://localhost").pathname;
        } catch {
          request.resume();
          response.statusCode = 400;
          response.setHeader("content-type", "text/plain; charset=utf-8");
          response.setHeader("connection", "close");
          response.end("Bad Request");
          return;
        }
      }

      const isRecognizedPath = pathname === "/mcp" ||
        (oauth !== undefined && (pathname === "/oauth/authorize" || pathname === "/oauth/token"));

      if (!isRecognizedPath) {
        response.statusCode = 404;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Not Found");
        return;
      }

      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }

      const failOAuth = (): void => {
        if (response.writableEnded) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        for (const name of response.getHeaderNames()) response.removeHeader(name);
        response.statusCode = 500;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.setHeader("pragma", "no-cache");
        response.end(JSON.stringify({ error: "server_error" }));
      };
      const runOAuth = (operation: () => Promise<boolean>): void => {
        void operation().then((handled) => {
          if (!handled) failOAuth();
        }).catch(failOAuth);
      };

      if (oauth !== undefined && pathname === "/oauth/authorize") {
        runOAuth(() => oauth.handleAuthorize(request, response));
        return;
      }

      if (oauth !== undefined && pathname === "/oauth/token") {
        runOAuth(() => oauth.handleToken(request, response));
        return;
      }

      if (oauth !== undefined) {
        const auth = oauth.requireScope(request, MCP_ACCESS_SCOPE);
        if (!auth.ok) {
          response.statusCode = auth.status;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.setHeader("cache-control", "no-store");
          response.setHeader("pragma", "no-cache");
          response.setHeader("www-authenticate", auth.wwwAuthenticate);
          response.end(JSON.stringify({ error: auth.error }));
          return;
        }
      }

      void mcpHandler(request, response);
    });

    if (options.hub !== undefined) {
      this.wireWs = attachAgentWebSocketServer(this.server, options.hub, {
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        bufferedAmountCeiling: options.bufferedAmountCeiling,
      });
    }
  }

  public async start(): Promise<McpHttpAddress> {
    if (this.startPromise !== undefined || this.closePromise !== undefined) {
      throw new Error("MCP HTTP host is already started or closing");
    }
    if (this.server === undefined) {
      throw new Error("MCP HTTP host cannot be restarted after close");
    }

    const server = this.server;
    this.startPromise = new Promise<McpHttpAddress>((resolve, reject) => {
      const onError = (error: Error) => {
        this.startPromise = undefined;
        reject(error);
      };
      server.once("error", onError);
      server.once("listening", () => {
        server.off("error", onError);
        this.listening = true;
        const address = server.address() as AddressInfo;
        resolve({ host: LOOPBACK_HOST, port: address.port });
      });
      server.listen({ host: LOOPBACK_HOST, port: this.port });
    });

    return this.startPromise;
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.startPromise !== undefined) {
      try {
        await this.startPromise;
      } catch {
        // A failed listen is still safe to close.
      }
    }
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.server === undefined) {
      return;
    }

    const server = this.server;
    const wireWs = this.wireWs;
    const listening = this.listening;
    const oauth = this.oauth;
    this.closePromise = (async () => {
      try {
        if (wireWs !== undefined) {
          await wireWs.close();
          this.wireWs = undefined;
        }
        if (!listening) {
          this.server = undefined;
          return;
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            this.server = undefined;
            this.listening = false;
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } finally {
        oauth?.revokeAll();
      }
    })().finally(() => {
      this.closePromise = undefined;
    });
    return this.closePromise;
  }
}

export function createMcpHttpHost(
  factory: McpServerFactory,
  port: number = DEFAULT_MCP_HTTP_PORT,
  options: LoopbackMcpHttpHostOptions = {},
): LoopbackMcpHttpHost {
  return new LoopbackMcpHttpHost(factory, port, options);
}
