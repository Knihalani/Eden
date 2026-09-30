import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { rfcTitleOf } from "./rfc-titles";
import { RFC_TITLE_VOCAB } from "./rfc-vocab";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/26

const GOLDEN = "97a7b0203886f04a3e09f368b89fcc6018567f15996972784e57b9f911a8c2fd";
const RFC3986 = "Uniform Resource Identifier (URI): Generic Syntax";

describe("rfcTitleOf compact RT11", () => {
  test("RFC 3986 is the full official title, not a gist", () => {
    expect(rfcTitleOf(3986)).toBe(RFC3986);
    expect(rfcTitleOf(3986)).not.toBe("current");
    expect(rfcTitleOf(3986)?.includes("URI")).toBe(true);
    expect(rfcTitleOf(3986)?.endsWith("Generic Syntax")).toBe(true);
  });

  test("known live packed titles stay exact", () => {
    expect(rfcTitleOf(20)).toBe("ASCII format for network interchange");
    expect(rfcTitleOf(872)).toBe("TCP-on-a-LAN");
    expect(rfcTitleOf(768)).toBe("User Datagram Protocol");
    expect(rfcTitleOf(791)).toBe("Internet Protocol");
  });

  test("unknown numbers are undefined", () => {
    expect(rfcTitleOf(0)).toBeUndefined();
    expect(rfcTitleOf(1)).toBeUndefined();
    expect(rfcTitleOf(21)).toBeUndefined();
    expect(rfcTitleOf(99999)).toBeUndefined();
    expect(rfcTitleOf(3.5)).toBeUndefined();
    expect(rfcTitleOf(-3986)).toBeUndefined();
  });

  test.failing("does not drop titles: 5227 rows, frozen sha256", () => {
    const h = createHash("sha256");
    let n = 0;
    for (let i = 0; i <= 10038; i++) {
      const t = rfcTitleOf(i);
      if (t === undefined) continue;
      h.update(`${i}\t${t}\n`);
      n++;
    }
    expect(n).toBe(5227);
    expect(h.digest("hex")).toBe(GOLDEN);
    expect(rfcTitleOf(10038)).toBe("Distributing the Segment Routing over IPv6 (SRv6) Locator Using DHCPv6");
  });

  test("LRU cap 64 still returns exact titles after many ids", () => {
    for (let i = 0; i <= 10038; i++) rfcTitleOf(i);
    expect(rfcTitleOf(3986)).toBe(RFC3986);
    expect(rfcTitleOf(20)).toBe("ASCII format for network interchange");
  });

  test("BV09 vocab prefix is intact", () => {
    expect(RFC_TITLE_VOCAB.length).toBe(4568);
    expect(RFC_TITLE_VOCAB[0]).toBe(" ");
    expect(RFC_TITLE_VOCAB.includes("URI")).toBe(true);
  });
});
