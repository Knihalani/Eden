import { describe, expect, test } from "bun:test";
import { containsSecret, redactString } from "./redact";
import { valueOverlap } from "./signals";
import { eq } from "./eq";

describe("redact regressions", () => {
  test("a pasted PEM private key loses its whole body, not just its banner", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/yGWywX7s",
      "bGhD2W8ZxKjVJU9p0Q==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redactString(`here is the key:\n${pem}\nplease rotate`);
    expect(out).not.toContain("MIIEpA");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("please rotate");
  });

  test("compact JSON keeps the fields after a secret", () => {
    const out = redactString('{"github_token":"ghp_abcdefghijklmnopqrstuvwxyz123456","owner":"octo","number":42}');
    expect(out).not.toContain("ghp_");
    expect(out).toContain('"owner":"octo"');
    expect(out).toContain('"number":42');
    expect(out.trimEnd().endsWith("}")).toBe(true);
    // The sentinel is deliberately not JSON-quoted — consumers gate on
    // containsRedaction() rather than parsing redacted text.
  });

  test("quoted values are consumed to their closing quote", () => {
    const out = redactString('{"password":"hunter, with comma","n":1}');
    expect(out).not.toContain("hunter");
    // The comma inside the quoted value belongs to the value, and what
    // follows survives.
    expect(out).toContain('"n":1}');
  });

  test("an escaped quote does not close the value mid-secret", () => {
    // The scan used to stop at `\"`, so the tail of the secret (`ret` here)
    // survived in the clear and the value was effectively split in two.
    const out = redactString('password="sec\\"ret, tail=kept"');
    expect(out).not.toContain("ret,");
    expect(out).not.toContain("tail=kept");
    expect(out).toBe("password=[REDACTED]");
    // A genuinely terminated value still ends where it should.
    const two = redactString('token="a\\"b" , user=octo');
    expect(two).toContain(", user=octo");
    expect(two.match(/\[REDACTED\]/g)).toHaveLength(1);
  });

  test("numbered credential keys are credentials too", () => {
    expect(redactString("API_KEY_2=sk_live_9f8e7d6c5b4a3210")).toBe("API_KEY_2=[REDACTED]");
    expect(containsSecret({ token1: "abc" })).toBe(true);
  });

  test("the sentinel itself is never re-redacted", () => {
    const once = redactString("Authorization: BEARER abc123def456");
    expect(redactString(once)).toBe(once);
  });
});

describe("valueOverlap shapes", () => {
  test("{} and [] are different values, not perfect overlap", () => {
    expect(valueOverlap({}, [])).toBeLessThan(1);
  });
});

describe("eq cycle safety", () => {
  test("self-referential sets terminate instead of overflowing", () => {
    const a: Set<unknown> = new Set([1]);
    a.add(a);
    const b: Set<unknown> = new Set([1]);
    b.add(b);
    expect(eq(a, b)).toBe(true);
  });

  test("self-referential maps terminate instead of overflowing", () => {
    const a: Map<unknown, unknown> = new Map([["k", 1]]);
    a.set("self", a);
    const b: Map<unknown, unknown> = new Map([["k", 1]]);
    b.set("self", b);
    expect(eq(a, b)).toBe(true);
  });

  test("plain-object cycles still compare as cycles, not equal-everything", () => {
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    const b: Record<string, unknown> = { n: 2 };
    b.self = b;
    expect(eq(a, b)).toBe(false);
  });
});

describe("sk- keys with dashes and short GitHub tokens", () => {
  test("dashed sk- keys and short ghp_/gho_/github_pat_ tokens are redacted", () => {
    for (const secret of [
      "sk-ant-api03-SECRETVALUE99",
      "sk-proj-abc123DEF456ghi789",
      "sk-live-abcdef123456",
      "ghp_abc123XYZ999",
      "gho_abc123XYZ999",
      "github_pat_abc123XYZ999",
    ]) {
      expect(redactString(`./deploy.sh ${secret} done`)).toBe("./deploy.sh [REDACTED] done");
      expect(containsSecret(secret)).toBe(true);
    }
  });

  test("hyphenated words that start with sk- and hold no digit are left alone", () => {
    // Shadow compares tool args after redact(): eating these made
    // "git push origin sk-fix-login" and "… sk-fix-logout" compare equal.
    for (const word of ["git push origin sk-fix-login", "git push origin sk-fix-logout", ".sk-canvas-node-offset {"]) {
      expect(redactString(word)).toBe(word);
      expect(containsSecret(word)).toBe(false);
    }
  });

  test("a long run of sk- without a digit stays linear", () => {
    const run = "sk-".repeat(400_000);
    const t0 = performance.now();
    expect(redactString(run)).toBe(run);
    expect(containsSecret(run)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("the per-install wrap key", () => {
  // Same shape as packages/cli home.ts resolveWrapKey: eden_local_ + 32 random bytes in hex.
  const key = `eden_local_${"0123456789abcdef".repeat(4)}`;

  test("is redacted on its own, with no credential noun next to it", () => {
    const out = redactString(`eden play lookup --key ${key} --input {}`);
    expect(out).toBe("eden play lookup --key [REDACTED] --input {}");
    expect(containsSecret(`echo ${key} | pbcopy`)).toBe(true);
    expect(containsSecret({ args: [key] })).toBe(true);
  });

  test("the public eden_dev key and the bare prefix are not secrets", () => {
    for (const word of ["eden play lookup --key eden_dev", "grep -r eden_local_ packages"]) {
      expect(redactString(word)).toBe(word);
      expect(containsSecret(word)).toBe(false);
    }
  });
});
