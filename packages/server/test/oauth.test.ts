import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHttpHost } from "../src/http-host.js";
import {
  MCP_ACCESS_SCOPE,
  createOAuthProvider,
  type OAuthApprovalCallback,
  type OAuthApprovalRequest,
  type OAuthClientConfig,
  type OAuthProvider,
  type OAuthProviderConfig,
} from "../src/oauth.js";

const CLIENT_ID = "test-client";
const CLIENT_NAME = "Test Client";
const REDIRECT_URI = "http://127.0.0.1:4321/callback";
const OTHER_SCOPE = "extra:scope";

const DEFAULT_CLIENTS: readonly OAuthClientConfig[] = [
  {
    clientId: CLIENT_ID,
    clientName: CLIENT_NAME,
    redirectUris: [REDIRECT_URI],
    scopes: [MCP_ACCESS_SCOPE, OTHER_SCOPE],
  },
];

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface RequestOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

function request(port: number, path: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  return new Promise((resolve, reject) => {
    const clientRequest = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: options.headers ?? {},
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
    if (options.body !== undefined) {
      clientRequest.end(options.body);
      return;
    }
    clientRequest.end();
  });
}

function authHeaders(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { host: `localhost:${port}`, origin: `http://localhost:${port}`, ...extra };
}

function requireHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  assert.equal(typeof value, "string", `expected header ${name} to be a single string`);
  return value as string;
}

function authorizePath(params: Record<string, string>): string {
  return `/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

function locationParams(location: string): URLSearchParams {
  return new URL(location, "http://localhost").searchParams;
}

function makeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function makeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function makeServerFactory(onInvoke?: () => void) {
  return () => {
    onInvoke?.();
    return new McpServer({ name: "test-server", version: "0.0.0" });
  };
}

function makeProvider(
  approve: OAuthApprovalCallback,
  extra: Partial<Omit<OAuthProviderConfig, "clients" | "approve">> = {},
  clients: readonly OAuthClientConfig[] = DEFAULT_CLIENTS,
): OAuthProvider {
  return createOAuthProvider({ clients, approve, ...extra });
}

const approveAll: OAuthApprovalCallback = async () => true;

async function startHost(
  oauth: OAuthProvider,
  factory: ReturnType<typeof makeServerFactory> = makeServerFactory(),
) {
  const host = createMcpHttpHost(factory, 0, { oauth });
  const address = await host.start();
  return { host, port: address.port };
}

async function authorizeAndGetCode(
  port: number,
  overrides: Partial<Record<"clientId" | "redirectUri" | "scope" | "state", string>> = {},
): Promise<{ code: string; verifier: string }> {
  const verifier = makeVerifier();
  const challenge = makeChallenge(verifier);
  const response = await request(port, authorizePath({
    response_type: "code",
    client_id: overrides.clientId ?? CLIENT_ID,
    redirect_uri: overrides.redirectUri ?? REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: overrides.scope ?? MCP_ACCESS_SCOPE,
    ...(overrides.state === undefined ? {} : { state: overrides.state }),
  }), { headers: authHeaders(port) });
  assert.equal(response.statusCode, 302);
  const location = requireHeader(response.headers, "location");
  const code = locationParams(location).get("code");
  assert.ok(typeof code === "string" && code.length > 0);
  return { code, verifier };
}

function tokenBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function exchangeToken(port: number, fields: Record<string, string>): Promise<HttpResponse> {
  return request(port, "/oauth/token", {
    method: "POST",
    headers: { ...authHeaders(port), "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody(fields),
  });
}

// (1) Provider construction rejects invalid configured redirect URIs.
test("rejects invalid configured redirect URIs at construction", () => {
  const baseClient = (redirectUri: string): OAuthClientConfig => ({
    clientId: CLIENT_ID,
    clientName: CLIENT_NAME,
    redirectUris: [redirectUri],
    scopes: [MCP_ACCESS_SCOPE],
  });

  for (const redirectUri of [
    "https://127.0.0.1:4321/callback",
    "http://example.com/callback",
    "http://user:pass@127.0.0.1:4321/callback",
    "http://127.0.0.1:4321/callback#frag",
  ]) {
    assert.throws(
      () => createOAuthProvider({ clients: [baseClient(redirectUri)], approve: approveAll }),
      TypeError,
      redirectUri,
    );
  }
});

// (2) Valid authorize with approval true redirects with code + state and safe metadata only.
test("valid authorize request with human approval redirects with code and state", async () => {
  let captured: OAuthApprovalRequest | undefined;
  const approve: OAuthApprovalCallback = async (approvalRequest) => {
    captured = approvalRequest;
    return true;
  };
  const provider = makeProvider(approve);
  const { host, port } = await startHost(provider);
  try {
    const verifier = makeVerifier();
    const challenge = makeChallenge(verifier);
    const response = await request(port, authorizePath({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: MCP_ACCESS_SCOPE,
      state: "xyz123",
    }), { headers: authHeaders(port) });

    assert.equal(response.statusCode, 302);
    const location = requireHeader(response.headers, "location");
    const params = locationParams(location);
    assert.ok(location.startsWith(REDIRECT_URI));
    assert.ok(params.get("code"));
    assert.equal(params.get("state"), "xyz123");
    assert.equal(params.get("error"), null);

    assert.ok(captured);
    const keys = Object.keys(captured).sort();
    assert.deepEqual(keys, ["clientId", "clientName", "redirectUri", "remoteAddress", "requestId", "requestedScopes"]);
    assert.equal(captured.clientId, CLIENT_ID);
    assert.equal(captured.clientName, CLIENT_NAME);
    assert.equal(captured.redirectUri, REDIRECT_URI);
    assert.deepEqual(captured.requestedScopes, [MCP_ACCESS_SCOPE]);
    for (const forbidden of ["code", "challenge", "verifier", "token"]) {
      assert.ok(!keys.some((key) => key.toLowerCase().includes(forbidden)));
    }
  } finally {
    await host.close();
  }
});

// (3) Unknown client or unregistered redirect fails locally with no redirect.
test("unknown client or unregistered redirect is rejected locally without a redirect", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const verifier = makeVerifier();
    const challenge = makeChallenge(verifier);

    const unknownClient = await request(port, authorizePath({
      response_type: "code",
      client_id: "unknown-client",
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: MCP_ACCESS_SCOPE,
    }), { headers: authHeaders(port) });
    assert.equal(unknownClient.statusCode, 400);
    assert.equal(unknownClient.headers.location, undefined);

    const unregisteredRedirect = await request(port, authorizePath({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: "http://127.0.0.1:9999/other",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: MCP_ACCESS_SCOPE,
    }), { headers: authHeaders(port) });
    assert.equal(unregisteredRedirect.statusCode, 400);
    assert.equal(unregisteredRedirect.headers.location, undefined);
  } finally {
    await host.close();
  }
});

// (4) Plain/missing PKCE and invalid requested scope are safely rejected without minting a code.
test("plain or missing PKCE and invalid scope are rejected without minting a code", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const verifier = makeVerifier();
    const challenge = makeChallenge(verifier);

    const plainMethod = await request(port, authorizePath({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "plain",
      scope: MCP_ACCESS_SCOPE,
    }), { headers: authHeaders(port) });
    assert.equal(plainMethod.statusCode, 302);
    let params = locationParams(requireHeader(plainMethod.headers, "location"));
    assert.equal(params.get("code"), null);
    assert.equal(params.get("error"), "invalid_request");

    const missingChallenge = await request(port, authorizePath({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: MCP_ACCESS_SCOPE,
    }), { headers: authHeaders(port) });
    assert.equal(missingChallenge.statusCode, 302);
    params = locationParams(requireHeader(missingChallenge.headers, "location"));
    assert.equal(params.get("code"), null);
    assert.equal(params.get("error"), "invalid_request");

    const badScope = await request(port, authorizePath({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "not-an-allowed-scope",
    }), { headers: authHeaders(port) });
    assert.equal(badScope.statusCode, 302);
    params = locationParams(requireHeader(badScope.headers, "location"));
    assert.equal(params.get("code"), null);
    assert.equal(params.get("error"), "invalid_scope");
  } finally {
    await host.close();
  }
});

// (5) Human denial, thrown errors, and timeouts all produce access_denied with no usable code.
test("human deny, throw, and timeout all result in access_denied with no usable code", async () => {
  const denyProvider = makeProvider(async () => false);
  const throwProvider = makeProvider(async () => {
    throw new Error("boom");
  });
  const timeoutProvider = makeProvider(() => new Promise<boolean>(() => {}), { approvalTimeoutMs: 50, codeTtlMs: 60_000 });

  for (const provider of [denyProvider, throwProvider, timeoutProvider]) {
    const { host, port } = await startHost(provider);
    try {
      const verifier = makeVerifier();
      const challenge = makeChallenge(verifier);
      const response = await request(port, authorizePath({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: MCP_ACCESS_SCOPE,
      }), { headers: authHeaders(port) });
      assert.equal(response.statusCode, 302);
      const params = locationParams(requireHeader(response.headers, "location"));
      assert.equal(params.get("error"), "access_denied");
      assert.equal(params.get("code"), null);
    } finally {
      await host.close();
    }
  }
});

// (6) Approved-subset-only scopes are honored; invalid approval scopes are denied.
test("approved subset scopes are honored and out-of-request approval scopes are denied", async () => {
  const subsetProvider = makeProvider(async () => [OTHER_SCOPE]);
  {
    const { host, port } = await startHost(subsetProvider);
    try {
      const { code, verifier } = await authorizeAndGetCode(port, { scope: `${MCP_ACCESS_SCOPE} ${OTHER_SCOPE}` });
      const tokenResponse = await exchangeToken(port, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      });
      assert.equal(tokenResponse.statusCode, 200);
      const parsed = JSON.parse(tokenResponse.body) as { scope: string };
      assert.equal(parsed.scope, OTHER_SCOPE);
    } finally {
      await host.close();
    }
  }

  const invalidSubsetProvider = makeProvider(async () => ["not-requested"]);
  {
    const { host, port } = await startHost(invalidSubsetProvider);
    try {
      const verifier = makeVerifier();
      const challenge = makeChallenge(verifier);
      const response = await request(port, authorizePath({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: MCP_ACCESS_SCOPE,
      }), { headers: authHeaders(port) });
      const params = locationParams(requireHeader(response.headers, "location"));
      assert.equal(params.get("error"), "access_denied");
    } finally {
      await host.close();
    }
  }
});

// (7) Full happy-path authorize -> token exchange.
test("happy path authorize then token exchange yields a valid bearer token", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const { code, verifier } = await authorizeAndGetCode(port);
    const tokenResponse = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(tokenResponse.statusCode, 200);
    assert.equal(tokenResponse.headers["cache-control"], "no-store");
    assert.equal(tokenResponse.headers.pragma, "no-cache");
    const parsed = JSON.parse(tokenResponse.body) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    assert.equal(parsed.token_type, "Bearer");
    assert.equal(parsed.scope, MCP_ACCESS_SCOPE);
    assert.ok(Number.isInteger(parsed.expires_in) && parsed.expires_in > 0);
    assert.ok(typeof parsed.access_token === "string" && parsed.access_token.length > 0);
  } finally {
    await host.close();
  }
});

// (8) Code replay fails.
test("replaying a consumed authorization code fails with invalid_grant", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const { code, verifier } = await authorizeAndGetCode(port);
    const fields = {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    };
    const first = await exchangeToken(port, fields);
    assert.equal(first.statusCode, 200);
    const replay = await exchangeToken(port, fields);
    assert.equal(replay.statusCode, 400);
    assert.deepEqual(JSON.parse(replay.body), { error: "invalid_grant" });
  } finally {
    await host.close();
  }
});

// (9) A wrong verifier still consumes the code; a correct-verifier retry then fails too.
test("a wrong verifier consumes the code so a correct retry also fails", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const { code, verifier } = await authorizeAndGetCode(port);
    const wrongVerifierResponse = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: makeVerifier(),
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(wrongVerifierResponse.statusCode, 400);

    const retryResponse = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(retryResponse.statusCode, 400);
    assert.deepEqual(JSON.parse(retryResponse.body), { error: "invalid_grant" });
  } finally {
    await host.close();
  }
});

// (10) A mismatched client/redirect at token time consumes the code and fails uniformly.
test("mismatched client or redirect at token exchange consumes the code and fails uniformly", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const { code, verifier } = await authorizeAndGetCode(port);
    const mismatchResponse = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: "http://127.0.0.1:4321/wrong-callback",
    });
    assert.equal(mismatchResponse.statusCode, 400);
    assert.deepEqual(JSON.parse(mismatchResponse.body), { error: "invalid_grant" });

    const correctRetry = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    assert.equal(correctRetry.statusCode, 400);
    assert.deepEqual(JSON.parse(correctRetry.body), { error: "invalid_grant" });
  } finally {
    await host.close();
  }
});

// (11) Code and token expiry are enforced using an injected clock.
test("code and token expiry are enforced via an injected clock", async () => {
  let clock = 1_000_000;
  const codeExpiryProvider = makeProvider(approveAll, {
    now: () => clock,
    approvalTimeoutMs: 500,
    codeTtlMs: 1_000,
    tokenTtlMs: 60_000,
  });
  {
    const { host, port } = await startHost(codeExpiryProvider);
    try {
      const { code, verifier } = await authorizeAndGetCode(port);
      clock += 2_000;
      const response = await exchangeToken(port, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(JSON.parse(response.body), { error: "invalid_grant" });
    } finally {
      await host.close();
    }
  }

  clock = 1_000_000;
  const tokenExpiryProvider = makeProvider(approveAll, {
    now: () => clock,
    approvalTimeoutMs: 30_000,
    codeTtlMs: 60_000,
    tokenTtlMs: 1_000,
  });
  {
    const { host, port } = await startHost(tokenExpiryProvider);
    try {
      const { code, verifier } = await authorizeAndGetCode(port);
      const tokenResponse = await exchangeToken(port, {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      });
      assert.equal(tokenResponse.statusCode, 200);
      const { access_token: accessToken } = JSON.parse(tokenResponse.body) as { access_token: string };

      clock += 2_000;
      const mcpResponse = await request(port, "/mcp", {
        headers: authHeaders(port, {
          authorization: `bearer ${accessToken}`,
          "content-type": "application/json",
          accept: "application/json",
        }),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unsupported/test" }),
      });
      assert.equal(mcpResponse.statusCode, 401);
    } finally {
      await host.close();
    }
  }
});

// (12) /mcp gating: missing/malformed/unknown token -> 401; valid but insufficient scope -> 403; valid + scope -> handler.
test("mcp endpoint gating enforces bearer token presence and scope", async () => {
  let factoryCalls = 0;
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider, makeServerFactory(() => {
    factoryCalls += 1;
  }));
  try {
    const noToken = await request(port, "/mcp", { headers: authHeaders(port) });
    assert.equal(noToken.statusCode, 401);
    assert.equal(requireHeader(noToken.headers, "cache-control"), "no-store");
    assert.ok(requireHeader(noToken.headers, "www-authenticate").includes("invalid_token"));
    assert.equal(factoryCalls, 0);

    const malformed = await request(port, "/mcp", { headers: authHeaders(port, { authorization: "Bearer" }) });
    assert.equal(malformed.statusCode, 401);
    assert.equal(factoryCalls, 0);

    const unknown = await request(port, "/mcp", {
      headers: authHeaders(port, { authorization: `Bearer ${randomBytes(32).toString("base64url")}` }),
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(factoryCalls, 0);

    const subsetProvider = makeProvider(async () => [OTHER_SCOPE]);
    const { host: subsetHost, port: subsetPort } = await startHost(subsetProvider, makeServerFactory(() => {
      factoryCalls += 1;
    }));
    try {
      const { code, verifier } = await authorizeAndGetCode(subsetPort, { scope: `${MCP_ACCESS_SCOPE} ${OTHER_SCOPE}` });
      const tokenResponse = await request(subsetPort, "/oauth/token", {
        method: "POST",
        headers: { ...authHeaders(subsetPort), "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        }),
      });
      const { access_token: subsetToken } = JSON.parse(tokenResponse.body) as { access_token: string };
      const before = factoryCalls;
      const insufficientScope = await request(subsetPort, "/mcp", {
        headers: authHeaders(subsetPort, { authorization: `Bearer ${subsetToken}` }),
      });
      assert.equal(insufficientScope.statusCode, 403);
      assert.equal(requireHeader(insufficientScope.headers, "cache-control"), "no-store");
      assert.ok(requireHeader(insufficientScope.headers, "www-authenticate").includes("insufficient_scope"));
      assert.equal(factoryCalls, before);
    } finally {
      await subsetHost.close();
    }

    const { code, verifier } = await authorizeAndGetCode(port);
    const tokenResponse = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    const { access_token: accessToken } = JSON.parse(tokenResponse.body) as { access_token: string };
    const authorized = await request(port, "/mcp", {
      headers: authHeaders(port, {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      }),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unsupported/test" }),
    });
    assert.notEqual(authorized.statusCode, 401);
    assert.notEqual(authorized.statusCode, 403);
    assert.notEqual(authorized.statusCode, 404);
    assert.ok(factoryCalls > 0);
  } finally {
    await host.close();
  }
});

// (13) Redirects require an exact match on registered localhost port/path/query.
test("redirect target must match the registered redirect URI exactly", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const verifier = makeVerifier();
    const challenge = makeChallenge(verifier);
    for (const redirectUri of [
      "http://127.0.0.1:9999/callback",
      "http://127.0.0.1:4321/callback/",
      "http://127.0.0.1:4321/callback?extra=1",
      "http://127.0.0.1:4321/other",
    ]) {
      const response = await request(port, authorizePath({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: MCP_ACCESS_SCOPE,
      }), { headers: authHeaders(port) });
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers.location, undefined);
    }
  } finally {
    await host.close();
  }
});

// (14) Codes and tokens carry >=32 bytes of entropy and never leak into error bodies.
test("codes and tokens have sufficient entropy and never appear in error responses", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const { code, verifier } = await authorizeAndGetCode(port);
    assert.ok(Buffer.from(code, "base64url").length >= 32);

    const tokenResponse = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    const { access_token: accessToken } = JSON.parse(tokenResponse.body) as { access_token: string };
    assert.ok(Buffer.from(accessToken, "base64url").length >= 32);

    const replay = await exchangeToken(port, {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
    });
    assert.ok(!replay.body.includes(code));
    assert.ok(!replay.body.includes(verifier));

    const badToken = randomBytes(32).toString("base64url");
    const mcpResponse = await request(port, "/mcp", {
      headers: authHeaders(port, { authorization: `Bearer ${badToken}` }),
    });
    assert.ok(!mcpResponse.body.includes(badToken));
    assert.ok(!mcpResponse.body.includes(accessToken));
  } finally {
    await host.close();
  }
});

// (15) The /agent WebSocket upgrade path is untouched by this change; regression coverage lives in
// http-host.test.ts and wire-ws-server's own tests, which do not configure oauth.
test("oauth configuration does not alter the recognized /agent path", async () => {
  const provider = makeProvider(approveAll);
  const { host, port } = await startHost(provider);
  try {
    const response = await request(port, "/agent", { headers: authHeaders(port) });
    assert.equal(response.statusCode, 404);
  } finally {
    await host.close();
  }
});


test("async OAuth handler failures are contained and sanitized", async () => {
  const throwingProvider: OAuthProvider = {
    async handleAuthorize() { throw new Error("secret authorize failure"); },
    async handleToken() { throw new Error("secret token failure"); },
    requireScope() { return { ok: true, clientId: CLIENT_ID, scopes: Object.freeze([MCP_ACCESS_SCOPE]) }; },
    revokeAll() {},
  };
  const { host, port } = await startHost(throwingProvider);
  try {
    const response = await request(port, "/oauth/authorize", { headers: authHeaders(port) });
    assert.equal(response.statusCode, 500);
    assert.equal(requireHeader(response.headers, "cache-control"), "no-store");
    assert.deepEqual(JSON.parse(response.body), { error: "server_error" });
    assert.doesNotMatch(response.body, /secret authorize failure/);
  } finally {
    await host.close();
  }
});

test("host close revokes OAuth codes and access tokens", async () => {
  const provider = makeProvider(approveAll);
  const first = await startHost(provider);
  const { code, verifier } = await authorizeAndGetCode(first.port);
  const tokenResponse = await exchangeToken(first.port, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });
  const { access_token: accessToken } = JSON.parse(tokenResponse.body) as { access_token: string };
  await first.host.close();

  const second = await startHost(provider);
  try {
    const response = await request(second.port, "/mcp", {
      headers: authHeaders(second.port, { authorization: `Bearer ${accessToken}` }),
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await second.host.close();
  }
});


test("OAuth handler false result fails closed instead of leaving the response pending", async () => {
  const falseProvider: OAuthProvider = {
    async handleAuthorize(_request, response) {
      response.setHeader("location", "http://should-not-leak.invalid/");
      return false;
    },
    async handleToken() { return false; },
    requireScope() { return { ok: true, clientId: CLIENT_ID, scopes: Object.freeze([MCP_ACCESS_SCOPE]) }; },
    revokeAll() {},
  };
  const { host, port } = await startHost(falseProvider);
  try {
    const response = await request(port, "/oauth/authorize", { headers: authHeaders(port) });
    assert.equal(response.statusCode, 500);
    assert.equal(response.headers.location, undefined);
    assert.equal(requireHeader(response.headers, "cache-control"), "no-store");
    assert.deepEqual(JSON.parse(response.body), { error: "server_error" });
  } finally {
    await host.close();
  }
});
