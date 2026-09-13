import { strict as assert } from "node:assert";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHttpHost } from "../src/http-host.js";

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function createServer(): McpServer {
  return new McpServer({ name: "test-server", version: "0.0.0" });
}

function rawRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port }, () => {
      socket.end(requestText);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.once("end", () => resolve(data));
    socket.once("error", reject);
  });
}

function request(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method: body === undefined ? "GET" : "POST",
      headers,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: responseBody,
        });
      });
    });
    clientRequest.once("error", reject);
    if (body !== undefined) {
      clientRequest.end(body);
      return;
    }
    clientRequest.end();
  });
}

test("rejects invalid ports", () => {
  for (const port of [-1, 1.5, 65536, Number.NaN]) {
    assert.throws(() => createMcpHttpHost(createServer, port), RangeError);
  }
});

test("starts on an ephemeral loopback port and keeps unknown paths minimal", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    const address = await host.start();
    assert.equal(address.host, "127.0.0.1");
    assert.ok(Number.isInteger(address.port));
    assert.ok(address.port > 0);

    const response = await request(address.port, "/not-mcp");
    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(response.body, "Not Found");
    assert.doesNotMatch(response.body, /freerdc|tool|device|version/i);
  } finally {
    await host.close();
  }
});

test("malformed absolute request target returns 400 without crashing the host", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    const { port } = await host.start();
    const malformed = await rawRequest(
      port,
      `GET http://[ HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(malformed, /^HTTP\/1\.1 400 /);
    assert.match(malformed, /Bad Request/);
    assert.doesNotMatch(malformed, /ERR_INVALID_URL|Invalid URL|stack/i);

    const followUp = await request(port, "/not-mcp");
    assert.equal(followUp.statusCode, 404);
  } finally {
    await host.close();
  }
});

test("absolute-form and protocol-relative request targets are rejected before routing", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    const { port } = await host.start();
    for (const target of ["http://example.invalid/mcp", "//example.invalid/mcp"]) {
      const response = await rawRequest(
        port,
        `GET ${target} HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
      );
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.doesNotMatch(response, /freerdc|tool|device|version/i);
    }

    const followUp = await request(port, "/not-mcp");
    assert.equal(followUp.statusCode, 404);
  } finally {
    await host.close();
  }
});

test("OPTIONS * receives a minimal server response without MCP routing", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    const { port } = await host.start();
    const response = await rawRequest(
      port,
      `OPTIONS * HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(response, /^HTTP\/1\.1 204 /);
    assert.doesNotMatch(response, /freerdc|tool|device|version/i);

    const followUp = await request(port, "/not-mcp");
    assert.equal(followUp.statusCode, 404);
  } finally {
    await host.close();
  }
});

test("rejects untrusted Host and Origin headers before MCP handling", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    const { port } = await host.start();
    const badHost = await request(port, "/mcp", {
      host: "example.invalid",
      origin: `http://localhost:${port}`,
    });
    assert.equal(badHost.statusCode, 403);

    const badOrigin = await request(port, "/mcp", {
      host: `localhost:${port}`,
      origin: "https://example.invalid",
    });
    assert.equal(badOrigin.statusCode, 403);
  } finally {
    await host.close();
  }
});

test("allows localhost Host and Origin through to the MCP handler", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    const { port } = await host.start();
    const response = await request(port, "/mcp", {
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
      "content-type": "application/json",
      accept: "application/json",
    }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unsupported/test" }));
    assert.notEqual(response.statusCode, 404);
    assert.notEqual(response.statusCode, 403);
  } finally {
    await host.close();
  }
});

test("cannot start twice, closes idempotently, and cannot restart after close", async () => {
  const host = createMcpHttpHost(createServer, 0);
  try {
    await host.start();
    await assert.rejects(host.start(), /already started or closing/);
    await host.close();
    await host.close();
    await assert.rejects(host.start(), /already started or closing/);
  } finally {
    await host.close();
  }
});
