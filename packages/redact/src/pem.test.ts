import { describe, expect, test } from "bun:test";
import { REDACTED } from "./redact";
import { redactPem } from "./redact";

/** The old behaviour: one lazy regex, block first, banner alone otherwise. Quadratic, so only on small inputs. */
const OLD =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|-----BEGIN [A-Z ]*PRIVATE KEY-----/gi;
const old = (s: string) => s.replace(OLD, REDACTED);

describe("redactPem", () => {
  test("agrees with the old lazy regex on random mixes of banners, ENDs and text", () => {
    let x = 17;
    const rnd = (n: number) => (x = (Math.imul(x, 1103515245) + 12345) >>> 0) % n;
    const parts = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----begin private key-----",
      "-----END RSA PRIVATE KEY-----",
      "-----END PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA0Z3",
      "\n",
      " plain words ",
      "-----",
      "-----BEGIN PUBLIC KEY-----",
    ];
    for (let round = 0; round < 3_000; round++) {
      const s = Array.from({ length: rnd(10) }, () => parts[rnd(parts.length)]).join("");
      expect(redactPem(s)).toBe(old(s));
    }
  });

  test("is linear on banners with no END (the old regex took ~25 s at 1 MB)", () => {
    const s = "-----BEGIN RSA PRIVATE KEY-----x".repeat(30_000); // ~1 MB
    const t0 = performance.now();
    const out = redactPem(s);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });
});
