#!/usr/bin/env node
/**
 * Node unit checks for golden auth-domain helpers (no Playwright / no prod hit).
 * Run: node --test e2e/golden/helpers-auth-domain.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  authStateMatchesBase,
  collectAuthStateHosts,
  isLocalHost,
} from "./helpers.mjs";

describe("isLocalHost", () => {
  it("accepts localhost and 127.0.0.1", () => {
    assert.equal(isLocalHost("localhost"), true);
    assert.equal(isLocalHost("127.0.0.1"), true);
  });
  it("rejects prod hosts", () => {
    assert.equal(isLocalHost("edenobservability.com"), false);
  });
});

describe("collectAuthStateHosts", () => {
  it("collects origins and cookie domains", () => {
    const hosts = collectAuthStateHosts({
      origins: [{ origin: "http://localhost:3000" }],
      cookies: [
        { name: "__session", domain: "localhost" },
        { name: "__client", domain: ".modest-bug-7.clerk.accounts.dev" },
      ],
    });
    assert.ok(hosts.includes("localhost"));
    assert.ok(hosts.includes("modest-bug-7.clerk.accounts.dev"));
  });
});

describe("authStateMatchesBase", () => {
  const localState = {
    origins: [{ origin: "http://localhost:3000" }],
    cookies: [
      { name: "__session", domain: "localhost" },
      { name: "__client", domain: ".modest-bug-7.clerk.accounts.dev" },
    ],
  };

  it("matches localhost auth to 127.0.0.1 BASE (local pair)", () => {
    const r = authStateMatchesBase(localState, "http://127.0.0.1:3000");
    assert.equal(r.ok, true);
    assert.equal(r.reason, "local-pair");
  });

  it("rejects localhost auth against prod BASE (W2-07 case)", () => {
    const r = authStateMatchesBase(localState, "https://edenobservability.com");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "host-mismatch");
    assert.equal(r.baseHost, "edenobservability.com");
  });

  it("matches prod cookies to prod BASE", () => {
    const prodState = {
      origins: [{ origin: "https://edenobservability.com" }],
      cookies: [{ name: "__session", domain: ".edenobservability.com" }],
    };
    const r = authStateMatchesBase(prodState, "https://edenobservability.com");
    assert.equal(r.ok, true);
  });

  it("rejects empty hosts", () => {
    const r = authStateMatchesBase({ origins: [], cookies: [] }, "http://localhost:3000");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no-hosts");
  });
});

describe("portal-audit.mjs BASE/BASE_URL", () => {
  it("honors env BASE or BASE_URL (does not hardcode localhost-only)", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../portal-audit.mjs"), "utf8");
    assert.match(src, /process\.env\.BASE\s*\|\|\s*process\.env\.BASE_URL/);
    assert.doesNotMatch(
      src,
      /const BASE\s*=\s*`http:\/\/127\.0\.0\.1:\$\{PORT\}`/,
    );
  });
});
