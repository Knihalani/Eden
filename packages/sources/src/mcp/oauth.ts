/**
 * The client side of MCP's authorization spec (2025-06-18 and 2025-11-25), opt-in (D1874): an `AuthHook` for
 * `StreamableHttpTransport`'s `auth` option. Neither `index.ts` nor Eden's own path imports this file; Eden holds
 * operator-issued credentials and passes them as headers.
 *
 * The flow, on a 401 from the MCP server:
 * 1. protected-resource metadata (RFC 9728), from the `resource_metadata` of the 401's `WWW-Authenticate`, else the
 *    server's well-known URLs; its `resource` must be this server's;
 * 2. the first authorization server's metadata (RFC 8414, else OpenID Connect discovery); its `issuer` must be
 *    exactly the one named, and it must offer PKCE with S256;
 * 3. a client: the one given, the one registered with that issuer before (kept in the store), or dynamic
 *    registration (RFC 7591) where the server offers it;
 * 4. an authorization URL with PKCE S256, a `state` and the RFC 8707 `resource`, handed to `onRedirect`; the caller
 *    sends the user there and passes the callback URL to `finishAuth`, which checks the state and exchanges the code;
 * 5. the tokens, in a pluggable `TokenStore`, bound to the issuer, token endpoint and resource they came from; an
 *    expired access token is refreshed (one refresh at a time, whatever the number of callers).
 *
 * Bounded and strict, as everything else here: HTTPS only (`http:` on a loopback host only), every response read to
 * at most `maxResponseBytes` (64 KiB) within `timeoutMs`, JSON shape-checked before it is parsed, no redirect followed
 * to another origin (none at all for a POST), the access token only for this server's URL and the refresh token only
 * to the token endpoint that issued it, and no token, code, verifier or server text in an error (the OAuth `error`
 * code is kept when it is a plain code).
 */
import type { AuthHook } from "./http";
import { parseJsonBytes } from "./json";

/** What a token store keeps: plain JSON values under string keys. */
export interface TokenStore {
  get(key: string): unknown | Promise<unknown>;
  set(key: string, value: unknown): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** The default store: this process's memory. A program that keeps tokens across runs passes its own. */
export class MemoryTokenStore implements TokenStore {
  private readonly values = new Map<string, unknown>();
  get(key: string): unknown {
    return this.values.get(key);
  }
  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
  delete(key: string): void {
    this.values.delete(key);
  }
}

/** A client registered with an authorization server. */
export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  /** How the client authenticates at the token endpoint; default `client_secret_basic` with a secret, else `none`. */
  token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
}

/** Tokens as kept, with what they are bound to. */
export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token expires (ms since the epoch), when the server said. */
  expiresAt?: number;
  scope?: string;
  issuer: string;
  tokenEndpoint: string;
  resource: string;
  clientId: string;
}

export interface OAuthOptions {
  /** Where the authorization server sends the user back: `https:`, or `http:` on a loopback host. */
  redirectUrl: string;
  /** Sends the user to the authorization URL (opens a browser, prints a link…). Untrusted input never reaches it. */
  onRedirect: (authorizationUrl: URL) => void | Promise<void>;
  /** A client registered beforehand; without one, dynamic registration is used where offered. */
  client?: OAuthClient;
  /** Sent in dynamic registration. */
  clientName?: string;
  /** Scope asked for; default: the 401's `scope`, else the resource's `scopes_supported`. */
  scope?: string;
  /** Default `MemoryTokenStore`. */
  store?: TokenStore;
  /** Each request to a metadata, registration or token endpoint (default 10 s). */
  timeoutMs?: number;
  /** Largest response read from those endpoints (default 64 KiB). */
  maxResponseBytes?: number;
  /** Tests. */
  fetch?: typeof fetch;
}

/** An authorization failure, in fixed words: never a token, a code, or the server's text. */
export class OAuthError extends Error {
  constructor(message: string) {
    super(`OAuth: ${message}`);
    this.name = "OAuthError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
/** An access token this close to its expiry is refreshed before use. */
const EXPIRY_MARGIN_MS = 30_000;
/** Same-origin redirects a metadata GET follows, at most. */
const MAX_REDIRECTS = 3;
/** Authorizations begun and not finished, at most (the oldest is dropped). */
const MAX_PENDING = 16;

interface Discovered {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
}

interface Pending {
  state: string;
  verifier: string;
  redirectUrl: string;
  client: OAuthClient;
  discovered: Discovered;
}

/**
 * The `AuthHook` for one MCP server. `authorization` gives its bearer token (refreshed when it has expired); a 401
 * starts an authorization (`onRedirect`), finished by `finishAuth` with the callback URL, after which the caller
 * connects again.
 */
export class OAuthClientProvider implements AuthHook {
  /** The server's canonical URI (RFC 8707's `resource`): its origin and path, no query or fragment. */
  readonly resource: string;
  private readonly store: TokenStore;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private refreshing: Promise<StoredTokens | undefined> | null = null;
  private readonly pending: Pending[] = [];

  constructor(
    serverUrl: URL | string,
    private readonly options: OAuthOptions,
  ) {
    const url = new URL(serverUrl);
    secure(url, "the MCP server's URL");
    secure(new URL(options.redirectUrl), "the redirect URL");
    this.resource = canonical(url);
    this.store = options.store ?? new MemoryTokenStore();
    this.fetchFn = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_BYTES;
  }

  /** The stored tokens for this server, if any. */
  async tokens(): Promise<StoredTokens | undefined> {
    const t = (await this.store.get(this.key())) as StoredTokens | undefined;
    return t && t.resource === this.resource && typeof t.accessToken === "string" ? t : undefined;
  }

  /** Forgets this server's tokens (a sign-out). */
  async clear(): Promise<void> {
    await this.store.delete(this.key());
  }

  async authorization(url: URL, signal?: AbortSignal): Promise<string | undefined> {
    // A token is for the server it was issued for: a transport to any other URL gets none.
    if (canonical(url) !== this.resource) return undefined;
    let t = await this.tokens();
    if (t?.expiresAt !== undefined && t.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
      t = t.refreshToken ? await this.refresh(t, signal).catch(() => undefined) : undefined;
    }
    return t ? `Bearer ${t.accessToken}` : undefined;
  }

  async unauthorized(challenge: {
    status: number;
    wwwAuthenticate: string | null;
    url: URL;
    signal?: AbortSignal;
  }): Promise<boolean> {
    if (canonical(challenge.url) !== this.resource) return false;
    const params = parseChallenge(challenge.wwwAuthenticate);
    const held = await this.tokens();
    // An expired or revoked access token: a refresh is tried first, unless the server asks for more scope.
    if (challenge.status === 401 && held?.refreshToken && params.error !== "insufficient_scope") {
      const fresh = await this.refresh(held, challenge.signal).catch(() => undefined);
      if (fresh) return true;
    }
    await this.authorize(params, challenge.signal);
    return false;
  }

  /**
   * Begins an authorization without waiting for a 401 (the same discovery), handing the URL to `onRedirect`.
   * `resourceMetadata` is a 401's `resource_metadata`, when the caller has one.
   */
  async authorize(params: Challenge = {}, signal?: AbortSignal): Promise<void> {
    const discovered = await this.discover(params, signal);
    const client = await this.client(discovered, signal);
    const verifier = random(32);
    const state = random(32);
    const url = new URL(discovered.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.client_id);
    url.searchParams.set("redirect_uri", this.options.redirectUrl);
    url.searchParams.set("code_challenge", await challengeOf(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("resource", this.resource);
    const scope = this.options.scope ?? params.scope ?? discovered.scope;
    if (scope) url.searchParams.set("scope", scope);
    this.pending.push({ state, verifier, redirectUrl: this.options.redirectUrl, client, discovered });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    await this.options.onRedirect(url);
  }

  /**
   * Finishes an authorization from the callback: the URL the user came back to (or its query). The state must be
   * one this provider began, and is used once; the code is exchanged with that flow's verifier and resource.
   */
  async finishAuth(callback: URL | string, signal?: AbortSignal): Promise<void> {
    const query =
      typeof callback === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(callback)
        ? new URLSearchParams(callback.replace(/^\?/, ""))
        : new URL(callback).searchParams;
    const state = query.get("state") ?? "";
    const at = this.pending.findIndex((p) => sameSecret(p.state, state));
    if (at < 0) throw new OAuthError("the callback's state is not one this client began");
    const flow = this.pending.splice(at, 1)[0]!;
    const error = query.get("error");
    if (error !== null) throw new OAuthError(`the authorization was refused (${code(error)})`);
    // RFC 9207: an `iss` in the callback must be the issuer the flow began with (a mix-up attack otherwise).
    const iss = query.get("iss");
    if (iss !== null && iss !== flow.discovered.issuer) throw new OAuthError("the callback came from another issuer");
    const authCode = query.get("code");
    if (!authCode) throw new OAuthError("the callback holds no code");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: authCode,
      redirect_uri: flow.redirectUrl,
      code_verifier: flow.verifier,
      resource: this.resource,
    });
    const t = await this.tokenRequest(flow.discovered, flow.client, body, signal);
    await this.save(t, flow.discovered, flow.client);
  }

  /** One refresh at a time: callers that ask while one runs share it. */
  private refresh(held: StoredTokens, signal?: AbortSignal): Promise<StoredTokens | undefined> {
    this.refreshing ??= (async () => {
      try {
        const client = await this.clientFor(held);
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: held.refreshToken!,
          resource: this.resource,
        });
        if (held.scope) body.set("scope", held.scope);
        const discovered: Discovered = {
          issuer: held.issuer,
          authorizationEndpoint: "",
          tokenEndpoint: held.tokenEndpoint,
        };
        const t = await this.tokenRequest(discovered, client, body, signal);
        // A server may keep the refresh token unrotated: the old one stays.
        return await this.save({ ...t, refresh_token: t.refresh_token ?? held.refreshToken }, discovered, client);
      } catch (e) {
        // A refresh the server refused will not succeed later: the tokens are dropped, and a 401 starts over.
        if (e instanceof OAuthError && /invalid_grant/.test(e.message)) await this.clear();
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async save(t: TokenResponse, d: Discovered, client: OAuthClient): Promise<StoredTokens> {
    const stored: StoredTokens = {
      accessToken: t.access_token,
      ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}),
      ...(t.expires_in !== undefined ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}),
      ...(t.scope ? { scope: t.scope } : {}),
      issuer: d.issuer,
      tokenEndpoint: d.tokenEndpoint,
      resource: this.resource,
      clientId: client.client_id,
    };
    await this.store.set(this.key(), stored);
    return stored;
  }

  private key(): string {
    return `tokens ${this.resource}`;
  }

  /** The client for an issuer: the one given, the one registered before, or a new dynamic registration. */
  private async client(d: Discovered, signal?: AbortSignal): Promise<OAuthClient> {
    if (this.options.client) return this.options.client;
    const key = `client ${d.issuer}`;
    const kept = (await this.store.get(key)) as OAuthClient | undefined;
    if (kept && typeof kept.client_id === "string") return kept;
    if (!d.registrationEndpoint) throw new OAuthError("no client is given and the server offers no registration");
    const res = await this.request(d.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: this.options.clientName ?? "MCP client",
        redirect_uris: [this.options.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal,
    });
    if (res.status !== 201 && res.status !== 200) throw new OAuthError(`registration failed (HTTP ${res.status})`);
    const x = res.json;
    if (!isObject(x) || !isToken(x.client_id)) throw new OAuthError("registration returned no client id");
    const secret = typeof x.client_secret === "string" ? x.client_secret : undefined;
    const method = x.token_endpoint_auth_method;
    const client: OAuthClient = {
      client_id: x.client_id,
      ...(secret ? { client_secret: secret } : {}),
      ...(method === "client_secret_post" || method === "client_secret_basic" || method === "none"
        ? { token_endpoint_auth_method: method }
        : {}),
    };
    await this.store.set(key, client);
    return client;
  }

  /** The client the held tokens were issued to. */
  private async clientFor(held: StoredTokens): Promise<OAuthClient> {
    if (this.options.client?.client_id === held.clientId) return this.options.client;
    const kept = (await this.store.get(`client ${held.issuer}`)) as OAuthClient | undefined;
    return kept?.client_id === held.clientId ? kept : { client_id: held.clientId };
  }

  /** Protected-resource metadata, then its first authorization server's metadata, each checked. */
  private async discover(params: Challenge, signal?: AbortSignal): Promise<Discovered> {
    const server = new URL(this.resource);
    const candidates: string[] = [];
    if (params.resourceMetadata) {
      let hinted: URL;
      try {
        hinted = new URL(params.resourceMetadata);
      } catch {
        throw new OAuthError("the resource metadata URL is not a URL");
      }
      candidates.push(hinted.href);
    } else {
      const path = server.pathname === "/" ? "" : server.pathname;
      if (path) candidates.push(new URL(`/.well-known/oauth-protected-resource${path}`, server).href);
      candidates.push(new URL("/.well-known/oauth-protected-resource", server).href);
    }
    let prm: Record<string, unknown> | null = null;
    for (const c of candidates) {
      const res = await this.request(c, { method: "GET", headers: { accept: "application/json" }, signal });
      if (res.status === 200 && isObject(res.json)) {
        prm = res.json;
        break;
      }
    }
    if (!prm) throw new OAuthError("the server published no protected-resource metadata");
    // RFC 9728 §3.3: the metadata must be about this resource, or a server could send the user to another's.
    if (typeof prm.resource !== "string" || !sameResource(prm.resource, this.resource)) {
      throw new OAuthError("the protected-resource metadata is for another resource");
    }
    const servers = prm.authorization_servers;
    if (!Array.isArray(servers) || typeof servers[0] !== "string") {
      throw new OAuthError("the protected-resource metadata names no authorization server");
    }
    const issuer = servers[0];
    let issuerUrl: URL;
    try {
      issuerUrl = new URL(issuer);
    } catch {
      throw new OAuthError("the authorization server's issuer is not a URL");
    }
    secure(issuerUrl, "the authorization server");
    if (issuerUrl.search || issuerUrl.hash) throw new OAuthError("the issuer has a query or fragment");
    const as = await this.serverMetadata(issuerUrl, signal);
    // RFC 8414 §3.3: the issuer in the metadata is exactly the one asked about.
    if (as.issuer !== issuer) throw new OAuthError("the authorization server's metadata names another issuer");
    const methods = as.code_challenge_methods_supported;
    if (!Array.isArray(methods) || !methods.includes("S256")) {
      throw new OAuthError("the authorization server does not offer PKCE with S256");
    }
    const endpoint = (v: unknown, what: string): string => {
      if (typeof v !== "string") throw new OAuthError(`the authorization server has no ${what}`);
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        throw new OAuthError(`the ${what} is not a URL`);
      }
      secure(u, `the ${what}`);
      return u.href;
    };
    const scopes = prm.scopes_supported;
    return {
      issuer,
      authorizationEndpoint: endpoint(as.authorization_endpoint, "authorization endpoint"),
      tokenEndpoint: endpoint(as.token_endpoint, "token endpoint"),
      ...(as.registration_endpoint !== undefined
        ? { registrationEndpoint: endpoint(as.registration_endpoint, "registration endpoint") }
        : {}),
      ...(Array.isArray(scopes) && scopes.every((s) => typeof s === "string") && scopes.length > 0
        ? { scope: scopes.join(" ") }
        : {}),
    };
  }

  /** RFC 8414 then OpenID Connect discovery, in the spec's order for an issuer with and without a path. */
  private async serverMetadata(issuer: URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const path = issuer.pathname.replace(/\/$/, "");
    const urls = path
      ? [
          `/.well-known/oauth-authorization-server${path}`,
          `/.well-known/openid-configuration${path}`,
          `${path}/.well-known/openid-configuration`,
        ]
      : ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"];
    for (const u of urls) {
      const res = await this.request(new URL(u, issuer).href, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
      if (res.status === 200 && isObject(res.json)) return res.json;
    }
    throw new OAuthError("the authorization server published no metadata");
  }

  /** A token request (code or refresh), with the client's authentication; the response checked. */
  private async tokenRequest(
    d: Discovered,
    client: OAuthClient,
    body: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<TokenResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    const method = client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_basic" : "none");
    if (method === "client_secret_basic" && client.client_secret) {
      const pair = `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`;
      headers.authorization = `Basic ${btoa(pair)}`;
    } else {
      body.set("client_id", client.client_id);
      if (method === "client_secret_post" && client.client_secret) body.set("client_secret", client.client_secret);
    }
    const res = await this.request(d.tokenEndpoint, { method: "POST", headers, body: body.toString(), signal });
    const x = res.json;
    if (res.status !== 200) {
      const why = isObject(x) && typeof x.error === "string" ? `, ${code(x.error)}` : "";
      throw new OAuthError(`the token request failed (HTTP ${res.status}${why})`);
    }
    if (!isObject(x) || !isToken(x.access_token)) throw new OAuthError("the token response holds no access token");
    if (typeof x.token_type !== "string" || x.token_type.toLowerCase() !== "bearer") {
      throw new OAuthError("the token is not a bearer token");
    }
    const expires = x.expires_in;
    return {
      access_token: x.access_token,
      ...(isToken(x.refresh_token) ? { refresh_token: x.refresh_token } : {}),
      ...(typeof expires === "number" && Number.isFinite(expires) && expires >= 0 ? { expires_in: expires } : {}),
      ...(typeof x.scope === "string" ? { scope: x.scope } : {}),
    };
  }

  /**
   * One bounded request: HTTPS (or loopback), within the timeout, at most `maxBytes` read and shape-checked before it
   * is parsed; a GET follows at most three redirects within its origin, a POST none.
   */
  private async request(
    href: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ status: number; json: unknown }> {
    let url = new URL(href);
    secure(url, "an authorization endpoint");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    try {
      for (let hop = 0; ; hop++) {
        const res = await this.fetchFn(url, { ...init, signal, redirect: "manual" });
        if (res.status >= 300 && res.status < 400 && res.status !== 304) {
          await res.body?.cancel().catch(() => {});
          const location = res.headers.get("location");
          let target: URL | null = null;
          try {
            target = location ? new URL(location, url) : null;
          } catch {
            target = null;
          }
          if (init.method !== "GET" || !target || target.origin !== url.origin || hop >= MAX_REDIRECTS) {
            throw new OAuthError(`a redirect (HTTP ${res.status}) was not followed`);
          }
          url = target;
          continue;
        }
        const length = Number(res.headers.get("content-length") ?? "0");
        if (length > this.maxBytes) {
          await res.body?.cancel().catch(() => {});
          throw new OAuthError(`a response was larger than ${this.maxBytes} bytes`);
        }
        const bytes = await readCapped(res, this.maxBytes);
        if (!bytes) throw new OAuthError(`a response was larger than ${this.maxBytes} bytes`);
        return { status: res.status, json: bytes.length ? parseJsonBytes(bytes) : undefined };
      }
    } catch (e) {
      if (e instanceof OAuthError) throw e;
      // A network error or a timeout: its text may hold the URL, which may hold a code; say only what happened.
      throw new OAuthError(timeout.aborted ? "a request timed out" : "a request failed");
    }
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** What a `WWW-Authenticate: Bearer` challenge says, as far as the flow reads it. */
export interface Challenge {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
}

/** The Bearer challenge's parameters (RFC 6750 §3), from a header that may hold other schemes too. */
export function parseChallenge(header: string | null): Challenge {
  if (!header || header.length > 8192) return {};
  const at = header.search(/(^|[\s,])Bearer(\s|$)/i);
  if (at < 0) return {};
  const out: Challenge = {};
  const re = /([a-z_][a-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/giy;
  let i = header.indexOf("Bearer", at) + 6;
  for (;;) {
    while (i < header.length && /[\s,]/.test(header[i]!)) i++;
    re.lastIndex = i;
    const m = re.exec(header);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]!;
    if (key === "resource_metadata") out.resourceMetadata = value;
    else if (key === "scope") out.scope = value;
    else if (key === "error") out.error = value;
    i = re.lastIndex;
    // A token68 or the next scheme: no more parameters of this one.
    if (i < header.length && header[i] !== "," && !/\s/.test(header[i]!)) break;
  }
  return out;
}

/** `https:`, or `http:` on a loopback host (a local server, a native app's redirect); anything else is refused. */
function secure(url: URL, what: string): void {
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) return;
  throw new OAuthError(`${what} must use HTTPS`);
}

/** RFC 8707's canonical URI for a server: lower-case scheme and host (the URL parser does both), path, no query. */
function canonical(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}${path}`;
}

/** Whether a metadata `resource` names this server (a trailing slash aside). */
function sameResource(declared: string, resource: string): boolean {
  try {
    return canonical(new URL(declared)) === resource && !new URL(declared).search && !new URL(declared).hash;
  } catch {
    return false;
  }
}

/** A string compared in time independent of where it differs. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** An OAuth `error` code as it may be shown: a plain code, or "error" when it is anything else. */
function code(e: string): string {
  return /^[a-z0-9_.-]{1,64}$/i.test(e) ? e : "error";
}

/** A token or id fit to send back in a header: printable ASCII, bounded. */
function isToken(x: unknown): x is string {
  return typeof x === "string" && /^[\x21-\x7e]{1,4096}$/.test(x);
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** `n` random bytes, base64url: a PKCE verifier (43 characters for 32 bytes) or a state. */
function random(n: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(n)));
}

async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The body's bytes, or null once it passes `max`. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
