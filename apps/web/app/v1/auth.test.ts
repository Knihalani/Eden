import { describe, expect, test } from "bun:test";
import { v1Authorized } from "./auth";

/**
 * The /v1 catch-all is exempt from Clerk, so its only gate is the bearer
 * token. On a managed install without EDEN_API_KEY the embedded handler would
 * otherwise present "eden_dev" — a credential that is public — to the
 * internet. edenKey() must refuse exactly there.
 */

/** Managed/dev env is process-global; every test pins it and restores after. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function bearer(token?: string): Request {
  return new Request("http://x/v1/tools", {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("/v1 bearer gate", () => {
  test("managed install with no EDEN_API_KEY refuses the public dev credential", () => {
    withEnv({ DATABASE_URL: "postgres://managed", VERCEL: undefined, EDEN_DEV: undefined }, () => {
      const errors: string[] = [];
      const orig = console.error;
      console.error = (...parts: unknown[]) => errors.push(parts.join(" "));
      try {
        expect(v1Authorized(bearer("eden_dev"))).toBe(false);
        // Any other guess fails too — nothing is authorised, not just eden_dev.
        expect(v1Authorized(bearer(""))).toBe(false);
        expect(v1Authorized(bearer(undefined))).toBe(false);
      } finally {
        console.error = orig;
      }
      expect(errors.some((e) => e.includes("EDEN_API_KEY is not set"))).toBe(true);
    });
  });

  test("managed install with EDEN_DEV=1 keeps the dev fallback", () => {
    withEnv({ DATABASE_URL: "postgres://managed", VERCEL: undefined, EDEN_DEV: "1" }, () => {
      expect(v1Authorized(bearer("eden_dev"))).toBe(true);
    });
  });

  test("managed install with a real key accepts it and refuses guesses", () => {
    withEnv({ DATABASE_URL: "postgres://managed", VERCEL: undefined, EDEN_API_KEY: "real_key" }, () => {
      expect(v1Authorized(bearer("real_key"))).toBe(true);
      expect(v1Authorized(bearer("eden_dev"))).toBe(false);
      // No timing-revealing prefix match.
      expect(v1Authorized(bearer("real_"))).toBe(false);
    });
  });

  test("unmanaged installs keep the dev fallback unless EDEN_DEV=0", () => {
    withEnv({ DATABASE_URL: undefined, VERCEL: undefined, EDEN_DEV: undefined }, () => {
      expect(v1Authorized(bearer("eden_dev"))).toBe(true);
    });
    withEnv({ DATABASE_URL: undefined, VERCEL: undefined, EDEN_DEV: "0" }, () => {
      expect(v1Authorized(bearer("eden_dev"))).toBe(false);
    });
  });
});
