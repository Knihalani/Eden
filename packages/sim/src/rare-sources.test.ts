import { describe, expect, test } from "bun:test";
import { addRareSources, RARE_SOURCE_IDS, RARE_SOURCES } from "./rare-sources";
import { REALISTIC, simSources } from "./sources";
import { buildWorld, SOURCES } from "./world";

describe("rare sources (P7)", () => {
  test("registers eight connectors with filler, deterministically, without touching the shared SOURCES", () => {
    const a = buildWorld({ seed: 41_000 });
    const b = buildWorld({ seed: 41_000 });
    const before = a.items.length;
    const added = addRareSources(a, 41);
    addRareSources(b, 41);
    expect(RARE_SOURCE_IDS.length).toBe(8);
    expect(RARE_SOURCE_IDS.every((id) => a.sources[id] === RARE_SOURCES[id]!.description)).toBe(true);
    expect(Object.keys(SOURCES)).toEqual(["gmail", "calendar", "drive", "crm", "slack"]);
    expect(a.items.length).toBe(before + added.length);
    expect(added.map((i) => [i.id, i.updatedAt])).toEqual(b.items.slice(before).map((i) => [i.id, i.updatedAt]));
    for (const id of RARE_SOURCE_IDS) {
      const own = added.filter((i) => i.sourceId === id);
      expect(own.length).toBeGreaterThanOrEqual(6);
      expect(own.every((i) => i.kind === RARE_SOURCES[id]!.kind && i.updatedAt < a.now)).toBe(true);
    }
    // Idempotent: a second call adds nothing.
    expect(addRareSources(a, 41)).toEqual([]);
  });

  test("each rare connector is a SimSource with its look-alike's profile, listing only its own items", () => {
    const world = buildWorld({ seed: 42_000 });
    addRareSources(world, 42);
    const sources = simSources(world, REALISTIC, 0, 42);
    expect(sources.map((s) => s.id)).toEqual([...Object.keys(SOURCES), ...RARE_SOURCE_IDS]);
    for (const s of sources.filter((x) => RARE_SOURCE_IDS.includes(x.id))) {
      const listed = s.listAll();
      expect(listed.length).toBeGreaterThanOrEqual(6);
      expect(listed.every((it) => it.sourceId === s.id)).toBe(true);
    }
  });
});
