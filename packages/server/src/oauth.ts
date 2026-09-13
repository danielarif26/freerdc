import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const MCP_ACCESS_SCOPE = "mcp:access";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_CODE_TTL_MS = 300_000;
const MAX_CODE_TTL_MS = 300_000;
const DEFAULT_TOKEN_TTL_MS = 3_600_000;
const MAX_TOKEN_TTL_MS = 3_600_000;
const MAX_TOKEN_BODY_BYTES = 16 * 1024;

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface OAuthClientConfig {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly scopes: readonly string[];
}

/** Safe, non-secret metadata handed to the human approval callback. */
export interface OAuthApprovalRequest {
  readonly requestId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly requestedScopes: readonly string[];
  readonly remoteAddress: string;
  readonly userAgent?: string;
}

export type OAuthApprovalResult = boolean | readonly string[];

export type OAuthApprovalCallback = (request: OAuthApprovalRequest) => Promise<OAuthApprovalResult>;

export interface OAuthProviderConfig {
  readonly clients: readonly OAuthClientConfig[];
  readonly approve: OAuthApprovalCallback;
  readonly approvalTimeoutMs?: number;
  readonly codeTtlMs?: number;
  readonly tokenTtlMs?: number;
  readonly now?: () => number;
}

export type AuthResult =
  | { readonly ok: true; readonly clientId: string; readonly scopes: readonly string[] }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      readonly error: string;
      readonly wwwAuthenticate: string;
    };

export interface OAuthProvider {
  handleAuthorize(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  handleToken(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  requireScope(request: IncomingMessage, scope: string): AuthResult;
  revokeAll(): void;
}

interface RegisteredClient {
  readonly clientName: string;
  readonly redirectUris: ReadonlySet<string>;
  readonly scopes: ReadonlySet<string>;
}

interface StoredCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

interface StoredToken {
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value, "ascii").digest("base64url");
}

function mintOpaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

function validatePositiveIntInRange(value: number | undefined, fallback: number, max: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new TypeError(`${label} must be a positive safe integer no greater than ${max}`);
  }
  return resolved;
}

function validateRedirectUri(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`redirect URI is not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new TypeError(`redirect URI must use the http: scheme: ${raw}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`redirect URI must not include userinfo: ${raw}`);
  }
  if (url.hash !== "") {
    throw new TypeError(`redirect URI must not include a fragment: ${raw}`);
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new TypeError(`redirect URI host must be a loopback host: ${raw}`);
  }
  return raw;
}

function validateScopeToken(scope: string, label: string): void {
  if (!SCOPE_TOKEN_PATTERN.test(scope)) {
    throw new TypeError(`${label} contains an invalid scope token: ${scope}`);
  }
}

function buildClients(clients: readonly OAuthClientConfig[]): Map<string, RegisteredClient> {
  const registry = new Map<string, RegisteredClient>();
  for (const client of clients) {
    if (!CLIENT_ID_PATTERN.test(client.clientId)) {
      throw new TypeError(`invalid client ID: ${client.clientId}`);
    }
    if (registry.has(client.clientId)) {
      throw new TypeError(`duplicate client ID: ${client.clientId}`);
    }
    if (typeof client.clientName !== "string" || client.clientName.length === 0) {
      throw new TypeError(`client ${client.clientId} must have a non-empty clientName`);
    }
    if (client.redirectUris.length === 0) {
      throw new TypeError(`client ${client.clientId} must register at least one redirect URI`);
    }
    if (client.scopes.length === 0) {
      throw new TypeError(`client ${client.clientId} must allow at least one scope`);
    }
    const redirectUris = new Set<string>();
    for (const redirectUri of client.redirectUris) {
      redirectUris.add(validateRedirectUri(redirectUri));
    }
    const scopes = new Set<string>();
    for (const scope of client.scopes) {
      validateScopeToken(scope, `client ${client.clientId} scopes`);
      scopes.add(scope);
    }
    registry.set(client.clientId, { clientName: client.clientName, redirectUris, scopes });
  }
  return registry;
}

function normalizeRequestedScopes(scopeParam: string): string[] {
  const tokens = scopeParam.split(/\s+/u).filter((token) => token.length > 0);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (!SCOPE_TOKEN_PATTERN.test(token)) {
      throw new Error("invalid_scope");
    }
    if (!seen.has(token)) {
      seen.add(token);
      unique.push(token);
    }
  }
  return unique;
}

async function raceApproval(
  approve: OAuthApprovalCallback,
  request: OAuthApprovalRequest,
  timeoutMs: number,
): Promise<OAuthApprovalResult | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, timeoutMs);
    Promise.resolve()
      .then(() => approve(request))
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      });
  });
}

function resolveApprovedScopes(
  result: OAuthApprovalResult | undefined,
  requestedScopes: readonly string[],
): readonly string[] | undefined {
  if (result === undefined || result === false) {
    return undefined;
  }
  if (result === true) {
    return Object.freeze([...requestedScopes]);
  }
  if (!Array.isArray(result)) {
    return undefined;
  }
  if (result.length === 0) {
    return undefined;
  }
  const requestedSet = new Set(requestedScopes);
  const seen = new Set<string>();
  for (const scope of result) {
    if (typeof scope !== "string" || !requestedSet.has(scope) || seen.has(scope)) {
      return undefined;
    }
    seen.add(scope);
  }
  return Object.freeze([...result]);
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");
  for (const [key, value] of Object.entries(extraHeaders)) {
    response.setHeader(key, value);
  }
  response.end(JSON.stringify(body));
}

function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let total = 0;
    const chunks: Buffer[] = [];
    let finished = false;

    const finish = (value: string | undefined): void => {
      if (finished) return;
      finished = true;
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        finish(undefined);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks).toString("utf8"));
    const onError = (): void => finish(undefined);

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

class OAuthProviderImpl implements OAuthProvider {
  readonly #clients: Map<string, RegisteredClient>;
  readonly #approve: OAuthApprovalCallback;
  readonly #approvalTimeoutMs: number;
  readonly #codeTtlMs: number;
  readonly #tokenTtlMs: number;
  readonly #now: () => number;
  readonly #codes = new Map<string, StoredCode>();
  readonly #tokens = new Map<string, StoredToken>();

  constructor(config: OAuthProviderConfig) {
    if (typeof config.approve !== "function") {
      throw new TypeError("approve must be an async approval callback");
    }
    this.#clients = buildClients(config.clients);
    this.#codeTtlMs = validatePositiveIntInRange(config.codeTtlMs, DEFAULT_CODE_TTL_MS, MAX_CODE_TTL_MS, "codeTtlMs");
    this.#tokenTtlMs = validatePositiveIntInRange(
      config.tokenTtlMs,
      DEFAULT_TOKEN_TTL_MS,
      MAX_TOKEN_TTL_MS,
      "tokenTtlMs",
    );
    this.#approvalTimeoutMs = validatePositiveIntInRange(
      config.approvalTimeoutMs,
      DEFAULT_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS,
      "approvalTimeoutMs",
    );
    if (this.#approvalTimeoutMs > this.#codeTtlMs) {
      throw new TypeError("approvalTimeoutMs must not exceed codeTtlMs");
    }
    this.#approve = config.approve;
    this.#now = config.now ?? Date.now;
  }

  public async handleAuthorize(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.method !== "GET") {
      writeJson(response, 400, { error: "invalid_request" });
      return true;
    }

    const url = new URL(request.url ?? "", "http://localhost");
    const params = url.searchParams;
    const clientId = params.get("client_id");
    const redirectUri = params.get("redirect_uri");

    if (clientId === null || redirectUri === null) {
      writeJson(response, 400, { error: "invalid_request" });
      return true;
    }
    const client = this.#clients.get(clientId);
    if (client === undefined || !client.redirectUris.has(redirectUri)) {
      writeJson(response, 400, { error: "invalid_request" });
      return true;
    }

    const redirectError = (error: string): void => {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error);
      const state = params.get("state");
      if (state !== null) {
        target.searchParams.set("state", state);
      }
      response.statusCode = 302;
      response.setHeader("location", target.toString());
      response.setHeader("cache-control", "no-store");
      response.end();
    };

    if (params.get("response_type") !== "code") {
      redirectError("unsupported_response_type");
      return true;
    }

    const codeChallenge = params.get("code_challenge");
    const codeChallengeMethod = params.get("code_challenge_method");
    if (
      codeChallengeMethod !== "S256" ||
      codeChallenge === null ||
      !CODE_CHALLENGE_PATTERN.test(codeChallenge)
    ) {
      redirectError("invalid_request");
      return true;
    }

    const scopeParam = params.get("scope");
    let requestedScopes: string[];
    try {
      if (scopeParam === null || scopeParam.length === 0) {
        throw new Error("invalid_scope");
      }
      requestedScopes = normalizeRequestedScopes(scopeParam);
      if (requestedScopes.length === 0 || requestedScopes.some((scope) => !client.scopes.has(scope))) {
        throw new Error("invalid_scope");
      }
    } catch {
      redirectError("invalid_scope");
      return true;
    }

    const approvalRequest: OAuthApprovalRequest = Object.freeze({
      requestId: randomUUID(),
      clientId,
      clientName: client.clientName,
      redirectUri,
      requestedScopes: Object.freeze([...requestedScopes]),
      remoteAddress: request.socket.remoteAddress ?? "",
      ...(typeof request.headers["user-agent"] === "string" ? { userAgent: request.headers["user-agent"] } : {}),
    });

    const approvalResult = await raceApproval(this.#approve, approvalRequest, this.#approvalTimeoutMs);
    const approvedScopes = resolveApprovedScopes(approvalResult, requestedScopes);
    if (approvedScopes === undefined) {
      redirectError("access_denied");
      return true;
    }

    const now = this.#now();
    this.#pruneExpired(now);
    const code = mintOpaqueSecret();
    this.#codes.set(sha256Hex(code), {
      clientId,
      redirectUri,
      challenge: codeChallenge,
      scopes: Object.freeze([...approvedScopes]),
      expiresAt: now + this.#codeTtlMs,
    });

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const state = params.get("state");
    if (state !== null) {
      target.searchParams.set("state", state);
    }
    response.statusCode = 302;
    response.setHeader("location", target.toString());
    response.setHeader("cache-control", "no-store");
    response.end();
    return true;
  }

  public async handleToken(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const fail = (): void => writeJson(response, 400, { error: "invalid_grant" });

    if (request.method !== "POST") {
      fail();
      return true;
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      fail();
      return true;
    }

    const body = await readBoundedBody(request, MAX_TOKEN_BODY_BYTES);
    if (body === undefined) {
      fail();
      return true;
    }

    const form = new URLSearchParams(body);
    const grantType = form.get("grant_type");
    const code = form.get("code");
    const codeVerifier = form.get("code_verifier");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    if (
      grantType !== "authorization_code" ||
      code === null || code.length === 0 ||
      codeVerifier === null || codeVerifier.length === 0 ||
      clientId === null || clientId.length === 0 ||
      redirectUri === null || redirectUri.length === 0
    ) {
      fail();
      return true;
    }

    const now = this.#now();
    this.#pruneExpired(now);
    const codeHash = sha256Hex(code);
    const record = this.#codes.get(codeHash);
    this.#codes.delete(codeHash);

    if (record === undefined || record.expiresAt <= this.#now()) {
      fail();
      return true;
    }
    if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
      fail();
      return true;
    }
    if (!CODE_VERIFIER_PATTERN.test(codeVerifier)) {
      fail();
      return true;
    }

    const derivedChallenge = base64UrlSha256(codeVerifier);
    const derivedBuffer = Buffer.from(derivedChallenge, "utf8");
    const storedBuffer = Buffer.from(record.challenge, "utf8");
    if (derivedBuffer.length !== storedBuffer.length || !timingSafeEqual(derivedBuffer, storedBuffer)) {
      fail();
      return true;
    }

    const accessToken = mintOpaqueSecret();
    this.#tokens.set(sha256Hex(accessToken), {
      clientId: record.clientId,
      scopes: Object.freeze([...record.scopes]),
      expiresAt: now + this.#tokenTtlMs,
    });

    writeJson(
      response,
      200,
      {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(this.#tokenTtlMs / 1000),
        scope: record.scopes.join(" "),
      },
    );
    return true;
  }

  public requireScope(request: IncomingMessage, scope: string): AuthResult {
    const wwwAuthenticateInvalid = 'Bearer realm="mcp", error="invalid_token"';
    const header = request.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (match === null) {
      return { ok: false, status: 401, error: "invalid_token", wwwAuthenticate: wwwAuthenticateInvalid };
    }
    const token = match[1] ?? "";
    const tokenHash = sha256Hex(token);
    const record = this.#tokens.get(tokenHash);
    if (record === undefined) {
      return { ok: false, status: 401, error: "invalid_token", wwwAuthenticate: wwwAuthenticateInvalid };
    }
    if (record.expiresAt <= this.#now()) {
      this.#tokens.delete(tokenHash);
      return { ok: false, status: 401, error: "invalid_token", wwwAuthenticate: wwwAuthenticateInvalid };
    }
    if (!record.scopes.includes(scope)) {
      return {
        ok: false,
        status: 403,
        error: "insufficient_scope",
        wwwAuthenticate: `Bearer realm="mcp", error="insufficient_scope", scope="${scope}"`,
      };
    }
    return { ok: true, clientId: record.clientId, scopes: record.scopes };
  }

  public revokeAll(): void {
    this.#codes.clear();
    this.#tokens.clear();
  }

  #pruneExpired(now: number): void {
    for (const [key, code] of this.#codes) {
      if (code.expiresAt <= now) this.#codes.delete(key);
    }
    for (const [key, token] of this.#tokens) {
      if (token.expiresAt <= now) this.#tokens.delete(key);
    }
  }
}

export function createOAuthProvider(config: OAuthProviderConfig): OAuthProvider {
  return new OAuthProviderImpl(config);
}
