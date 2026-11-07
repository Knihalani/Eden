/**
 * A `SourceDirectory` for per-user OAuth tokens (D108, D294): the shape an embedding uses when its users connect
 * their own Google accounts and Eden reads them through Google's hosted Gmail and Calendar MCP servers.
 *
 * Your app already runs the OAuth consent flow and stores each user's refresh token (in a vault, a KMS-encrypted
 * column). Eden never sees the refresh token or the client secret: this directory, running in your process, trades
 * the refresh token for a short-lived access token and hands Eden only that, as the user's `Authorization` header on
 * a preset spec (`connector-presets.ts`). Per user, never shared (D9):
 *
 * - An access token is reused until a minute before it expires, then refreshed; concurrent asks share one refresh.
 *   The cache holds at most one live access token per user and drops it on expiry or a failed refresh; call
 *   `forget` from your own account-removal path too.
 * - A refresh that fails (`invalid_grant`: the user revoked access) throws: `UserSources` takes that as the user's
 *   configuration error, closes their connections and serves them only the shared sources until it succeeds again.
 * - A rotated access token changes the spec's headers, so `UserSources` reconnects with it (its fingerprint changed).
 * - Ask for read-only scopes at consent (`gmail.readonly`, `calendar.readonly`): with them the provider itself refuses
 *   a write, beneath Eden's own read-only check (D7).
 *
 *   const users = new UserSources({ directory: oauthDirectory({ vault, tokenUrl, clientId, clientSecret, servers }) });
 *   const partner = buildPartner({ sources: users.resolver, ... });  // and createHandler(partner, config, users)
 */
import type { Scope } from "@eden/protocol";
import type { PresetSpec, SourceDirectory } from "@eden/server";

/** Where your app keeps each user's grant. Only this file reads it; nothing in it reaches Eden's engine. */
export interface TokenVault {
  /** The user's refresh token and which accounts they connected, or null when they connected none. */
  grant(scope: Scope): Promise<{ refreshToken: string; connected: ("gmail" | "google-calendar")[] } | null>;
}

export interface OAuthDirectoryOptions {
  vault: TokenVault;
  /** The provider's token endpoint (Google: https://oauth2.googleapis.com/token). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Each connected account's MCP server URL. */
  servers: Partial<Record<"gmail" | "google-calendar", string>>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Refresh this long before the provider's expiry, so a token never expires mid-lookup. */
const EARLY_MS = 60_000;

export function oauthDirectory(options: OAuthDirectoryOptions): SourceDirectory & { forget(scope: Scope): void } {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  // Per user: the current access token and when it expires, and a refresh in flight. Keyed by tenant and user (D9).
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const inflight = new Map<string, Promise<string>>();
  const key = (s: Scope) => `${s.tenantId}/${s.userId}`;

  async function refresh(scope: Scope, refreshToken: string): Promise<string> {
    const res = await doFetch(options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
      signal: AbortSignal.timeout(4_000),
    });
    // Never the body in the message: a provider's error can echo the request, and the message is logged.
    if (!res.ok) throw new Error(`token refresh failed for this user (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("token refresh returned no access token");
    tokens.set(key(scope), { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3_600) * 1_000 });
    return body.access_token;
  }

  async function accessToken(scope: Scope, refreshToken: string): Promise<string> {
    const held = tokens.get(key(scope));
    if (held && held.expiresAt - EARLY_MS > now()) return held.token;
    // An expiring token is not kept while a new one is fetched, nor after a refresh fails (a revoked grant).
    tokens.delete(key(scope));
    let p = inflight.get(key(scope));
    if (!p) {
      p = refresh(scope, refreshToken).finally(() => inflight.delete(key(scope)));
      inflight.set(key(scope), p);
    }
    return p;
  }

  const directory: SourceDirectory = async (scope) => {
    const grant = await options.vault.grant(scope);
    if (!grant) {
      tokens.delete(key(scope));
      return [];
    }
    const token = await accessToken(scope, grant.refreshToken);
    const specs: PresetSpec[] = [];
    for (const preset of grant.connected) {
      const url = options.servers[preset];
      if (!url) continue;
      specs.push({
        kind: "mcp",
        preset,
        id: preset === "gmail" ? "mail" : "calendar",
        url,
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return specs;
  };
  return Object.assign(directory, { forget: (scope: Scope) => void tokens.delete(key(scope)) });
}
