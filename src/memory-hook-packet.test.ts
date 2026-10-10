import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemory } from "./index";
import { ageInWords, declarativeBullet, PACKET_SOFT_BULLETS, renderPacket, shapePacket } from "./memory-hook-packet";
import type { ProvenanceNote } from "./memory-provenance";
import { MEMORY_PACKET_MARK, stripMemoryPacket } from "./memory-sota";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const ago = (ms: number) => NOW - ms;
const HOUR = 3_600_000;

const fact = (text: string, at = ago(HOUR)) => ({ id: text, text: `[fact · 1h · user] ${text}`, kind: "fact", at });
const episode = (text: string) => ({ id: text, text: `[episode · 1h · user] ${text}`, kind: "episode", at: ago(HOUR) });
const rule = (text: string) => ({ id: text, text, kind: "constraint", at: ago(HOUR) });
const procedure = (text: string) => ({ id: text, text, kind: "procedure", tags: ["howto"], at: ago(HOUR) });
const gist = (text: string) => ({ id: text, text, kind: "gist", tags: ["gist"], at: ago(HOUR) });

const fromUser = <T extends ProvenanceNote>(note: T) => ({ ...note, tags: [...(note.tags ?? []), "src:user"] });

describe("D14: declarative wording, claiming only the source a row shows (A6 §2.1)", () => {
  test("a rule the user set says so; a rule with no source is a plain bullet", () => {
    expect(declarativeBullet(fromUser(rule("Never merge PRs yourself.")), NOW)).toBe(
      "Rule you set: Never merge PRs yourself.",
    );
    expect(declarativeBullet(rule("Never merge PRs yourself."), NOW)).toBe("Never merge PRs yourself. (1 hour ago)");
  });

  test("other bullets end with their source and age, without the old [kind · age · src] tag", () => {
    expect(declarativeBullet(fromUser(fact("Our auth provider is Clerk", ago(3 * 7 * 86_400_000))), NOW)).toBe(
      "Our auth provider is Clerk (you said, 3 weeks ago)",
    );
    expect(declarativeBullet(gist("stack uses Redis"), NOW)).toBe(
      "stack uses Redis (earlier session notes, 1 hour ago)",
    );
    expect(declarativeBullet({ ...fact("CI is green"), tags: ["src:tool"] }, NOW)).toBe(
      "CI is green (from a tool result, 1 hour ago)",
    );
    expect(declarativeBullet(procedure("fix auth flake → src/auth.ts · verify: bun test auth"), NOW)).toBe(
      "fix auth flake → src/auth.ts · verify: bun test auth (from a tool result, 1 hour ago)",
    );
  });

  test("a row without a source says only how old it is; one without a wall-clock time, nothing", () => {
    expect(declarativeBullet(fact("Our auth provider is Clerk", ago(2 * HOUR)), NOW)).toBe(
      "Our auth provider is Clerk (2 hours ago)",
    );
    expect(declarativeBullet(episode("fix the login"), NOW)).toBe("fix the login (1 hour ago)");
    expect(declarativeBullet(fact("The database is postgres", 8), NOW)).toBe("The database is postgres");
    expect(declarativeBullet(fromUser(fact("The database is postgres", 8)), NOW)).toBe(
      "The database is postgres (you said)",
    );
  });

  test("ages in words", () => {
    expect(ageInWords(NOW - 20_000, NOW)).toBe("just now");
    expect(ageInWords(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(ageInWords(NOW - 5 * HOUR, NOW)).toBe("5 hours ago");
    expect(ageInWords(NOW - 2 * 86_400_000, NOW)).toBe("2 days ago");
    expect(ageInWords(NOW + HOUR, NOW)).toBe("just now");
    expect(ageInWords(12, NOW)).toBeUndefined();
    expect(ageInWords(undefined, NOW)).toBeUndefined();
  });
});

describe("D28: the packet's shape", () => {
  test("bullets keep their order; a kind that is full is skipped, never refilled", () => {
    const notes = [
      episode("e1"),
      rule("r1"),
      episode("e2"),
      episode("e3"),
      procedure("p1"),
      procedure("p2"),
      rule("r2"),
      rule("r3"),
    ];
    expect(shapePacket(notes).map((note) => note.id)).toEqual(["e1", "r1", "e2", "p1"]);
  });

  test("at most 4 bullets, facts included; a short packet stays short", () => {
    const facts = ["a", "b", "c", "d", "e", "f"].map((text) => fact(`fact ${text}`));
    expect(shapePacket(facts)).toHaveLength(PACKET_SOFT_BULLETS);
    expect(shapePacket([fact("only one")])).toHaveLength(1);
    expect(shapePacket([])).toEqual([]);
  });

  test("a bullet saying what an earlier one said is dropped, whatever its tag", () => {
    const notes = [fact("Our auth provider is Auth0"), { ...fact("our auth  provider is Auth0"), id: "x" }];
    expect(shapePacket(notes)).toHaveLength(1);
  });

  test("gists count as episodes", () => {
    expect(shapePacket([gist("g1"), episode("e1"), gist("g2"), fact("f1")]).map((note) => note.id)).toEqual([
      "g1",
      "e1",
      "f1",
    ]);
  });
});

describe("the rendered packet", () => {
  test("a header, then one line per bullet", () => {
    expect(renderPacket([fromUser(rule("Never merge PRs yourself.")), fact("Our auth provider is Clerk")], NOW)).toBe(
      `${MEMORY_PACKET_MARK}\n- Rule you set: Never merge PRs yourself.\n- Our auth provider is Clerk (1 hour ago)`,
    );
  });

  test("nothing to say is an empty string", () => {
    expect(renderPacket([], NOW)).toBe("");
    expect(renderPacket([fact("x".repeat(1000))], NOW)).toBe("");
  });

  test("within 900 bytes: a bullet that does not fit is skipped, never cut", () => {
    const long = fact(`long ${"y".repeat(850)}`);
    const packet = renderPacket([fact("short one"), long, fact("short two"), fact(`mid ${"z".repeat(300)}`)], NOW);
    expect(Buffer.byteLength(packet, "utf8")).toBeLessThanOrEqual(900);
    expect(packet).toContain("short one");
    expect(packet).toContain("short two");
    expect(packet).toContain("z".repeat(300));
    expect(packet).not.toContain("y".repeat(10));
  });
});

/** The headers literally, not the constant under test: today's (D14) and the one before P0.2. */
const HEADERS = ["Eden memory, recalled from earlier sessions:", "Eden Memory:"];

describe("packets in either wording: today's header and the one before P0.2", () => {
  test("a history that already holds a packet gets no second one", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-packet-marks-"));
    try {
      const mem = openMemory({ dir });
      mem.remember("The database is sqlite.");
      const ask = { role: "user", content: "what database do we use" };
      expect(mem.recall([ask]).length).toBeGreaterThan(0);
      for (const header of HEADERS) {
        expect(mem.recall([{ role: "system", content: `${header}\n- something earlier` }, ask])).toEqual([]);
      }
      mem.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stripMemoryPacket removes a packet's header and its bullets, and keeps the text around it", () => {
    for (const header of HEADERS) {
      const text = `Before.\n${header}\n- Rule you set: never merge\n- The database is sqlite (2 hours ago)\nAfter.`;
      expect(stripMemoryPacket(text)).toBe("Before.\n\nAfter.");
    }
  });
});

describe("P1.1: Updated items (A4 §4, D28's hard limit)", () => {
  const updated = <T extends ProvenanceNote>(note: T, was: string) => ({ ...note, was });

  test("an Updated item says so, and names the value it replaces unless its text already does", () => {
    expect(declarativeBullet(updated(fromUser(fact("The database is postgres")), "sqlite"), NOW)).toBe(
      "Updated: The database is postgres (was sqlite; you said, 1 hour ago)",
    );
    expect(declarativeBullet(updated(fromUser(episode("We switched auth from Auth0 to Clerk")), "Auth0"), NOW)).toBe(
      "Updated: We switched auth from Auth0 to Clerk (you said, 1 hour ago)",
    );
  });

  test("Updated items may pass the soft limit of 4, never the hard limit of 6; kind limits do not count them", () => {
    const facts = ["a", "b", "c", "d"].map((text) => fact(`fact ${text}`));
    const updates = ["u", "v", "w"].map((text) => updated(episode(`episode ${text}`), "old"));
    const shaped = shapePacket([...facts, ...updates]).map((note) => note.id);
    expect(shaped).toHaveLength(6);
    expect(shaped.slice(0, 4)).toEqual(facts.map((note) => note.id));
    expect(shaped.slice(4)).toEqual(["episode u", "episode v"]);
  });
});
