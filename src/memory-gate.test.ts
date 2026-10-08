import { describe, expect, test } from "bun:test";
import { admitNotes, admitsEpisode, identifierTokens } from "./memory-gate";
import { isUntyped } from "./memory-provenance";

const tool = (text: string) => ({ id: text, text, tags: ["src:tool"] });
const said = (text: string) => ({ id: text, text, tags: ["src:agent"] });
const typed = (text: string) => ({ id: text, text });

describe("A7 §4: identifier-shaped tokens", () => {
  test("paths, filenames, error codes, flags, versions, ids and symbols", () => {
    const tokens = identifierTokens(
      "Fix apps/web/app/login.ts (ERR_REQUIRE_ESM, E404) with --frozen-lockfile on v18.2.0; see c0042, getUser, user_id.",
    );
    for (const token of [
      "apps/web/app/login.ts",
      "err_require_esm",
      "e404",
      "--frozen-lockfile",
      "v18.2.0",
      "c0042",
      "getuser",
      "user_id",
    ])
      expect(tokens.has(token)).toBe(true);
  });

  test("a filename also yields its stem; plain words, numbers and abbreviations are not identifiers", () => {
    expect([...identifierTokens('Update "vitest.config.ts".')]).toEqual(["vitest.config.ts", "vitest.config"]);
    expect([...identifierTokens("The database is postgres, e.g. version 15 in 2026. Auth is Clerk.")]).toEqual([]);
  });
});

describe("A4 §3.0, A7 §4: an episode the user did not type needs STRONG evidence or MEDIUM from 2 cue parts", () => {
  test("a row from a tool result or the agent is an episode; a row of unknown source is not", () => {
    expect(isUntyped(tool("x"))).toBe(true);
    expect(isUntyped(said("x"))).toBe(true);
    expect(isUntyped(typed("x"))).toBe(false);
    expect(isUntyped({ id: "g", text: "x", kind: "gist", tags: ["gist"] })).toBe(false);
  });

  test("STRONG: an identifier-shaped token shared with the prompt", () => {
    expect(admitsEpisode(tool("File created at apps/web/app/db.ts"), { prompt: "explain apps/web/app/db.ts" })).toBe(
      true,
    );
    expect(admitsEpisode(tool("File created at apps/web/app/db.ts"), { prompt: "explain the db layer" })).toBe(false);
  });

  test("MEDIUM from two cue parts: the prompt and the previous typed prompt or the agent's last message", () => {
    const row = said("The billing retries back off exponentially");
    expect(admitsEpisode(row, { prompt: "why do billing jobs pile up?" })).toBe(false);
    expect(admitsEpisode(row, { prompt: "why do billing jobs pile up?", turn: "look at the retries" })).toBe(true);
    expect(admitsEpisode(row, { prompt: "why do billing jobs pile up?", prev: "Billing has 3 retries." })).toBe(true);
    expect(admitsEpisode(row, { prompt: "why is it slow?", turn: "and what about this?" })).toBe(false);
  });

  test("typed rows and gists keep today's admission, in order", () => {
    const notes = [
      tool("Exit code 1 in billing"),
      typed("We bill monthly"),
      said("billing is done"),
      tool("util.ts ok"),
    ];
    expect(admitNotes(notes, { prompt: "how does billing work in util.ts?" }).map((n) => n.id)).toEqual([
      "We bill monthly",
      "util.ts ok",
    ]);
  });
});
