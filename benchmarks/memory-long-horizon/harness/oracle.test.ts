/**
 * The world oracle: the truth of every slot and policy over time, by scope, with what a rewind takes back.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { itemId, Oracle, parseItemId, scopeChain, type Subject } from "./oracle";
import { removeTempDirs, tempDir } from "./testkit";

afterAll(removeTempDirs);

const SUBJECTS: Subject[] = [
  { key: "node.version", kind: "slot", words: ["node"], values: { "20": ["20"], "22": ["22"] } },
  { key: "auth.provider", kind: "slot", words: ["auth"], values: { Clerk: ["clerk"], Auth0: ["auth0"] } },
  { key: "policy:integrate|neg|*", kind: "policy", words: ["merge"], values: { "in force": ["don't merge"] } },
];

const at = (seq: number) => ({ seq, t: seq * 1000 });

describe("item ids and scopes", () => {
  test("an item is key@scope; the root scope is empty", () => {
    expect(itemId("pkg.manager", "")).toBe("pkg.manager@");
    expect(parseItemId("auth.provider@apps/web")).toEqual({ key: "auth.provider", scope: "apps/web" });
    expect(parseItemId("policy:integrate|neg|*@")).toEqual({ key: "policy:integrate|neg|*", scope: "" });
    expect(() => parseItemId("no-scope")).toThrow("is not key@scope");
  });

  test("a scope's chain runs from itself to the root", () => {
    expect(scopeChain("apps/web/app")).toEqual(["apps/web/app", "apps/web", "apps", ""]);
    expect(scopeChain("")).toEqual([""]);
  });
});

describe("the truth over time", () => {
  test("a value holds from the event it was set at, not before", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "auth.provider", scope: "apps/web", value: "Auth0" }], "user", at(3));
    oracle.apply([{ key: "auth.provider", scope: "apps/web", value: "Clerk" }], "repo", at(9));
    expect(oracle.truth("auth.provider", "apps/web", 2)).toBeUndefined();
    expect(oracle.truth("auth.provider", "apps/web", 3)).toEqual({ scope: "apps/web", value: "Auth0" });
    expect(oracle.truth("auth.provider", "apps/web", 8)?.value).toBe("Auth0");
    expect(oracle.truth("auth.provider", "apps/web", 9)?.value).toBe("Clerk");
  });

  test("a scope sees its nearest ancestor's value until it sets its own (cascade with override)", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "node.version", scope: "", value: "20" }], "init", at(0));
    oracle.apply([{ key: "node.version", scope: "apps/web", value: "22" }], "user", at(5));
    expect(oracle.truth("node.version", "packages/cli", 6)).toEqual({ scope: "", value: "20" });
    expect(oracle.truth("node.version", "apps/web/app", 6)).toEqual({ scope: "apps/web", value: "22" });
    expect(oracle.truth("node.version", "apps/web", 4)).toEqual({ scope: "", value: "20" });
    expect(oracle.truth("node.version", "", 6)).toEqual({ scope: "", value: "20" });
  });

  test("removing a scope's value uncovers its ancestor's; removing the last leaves null, not undefined", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "node.version", scope: "", value: "20" }], "init", at(0));
    oracle.apply([{ key: "node.version", scope: "apps/web", value: "22" }], "user", at(1));
    oracle.apply([{ key: "node.version", scope: "apps/web", value: null }], "repo", at(2));
    expect(oracle.truth("node.version", "apps/web", 2)).toEqual({ scope: "", value: "20" });
    oracle.apply([{ key: "node.version", scope: "", value: null }], "user", at(3));
    expect(oracle.truth("node.version", "apps/web", 3)).toEqual({ scope: "apps/web", value: null });
    expect(oracle.truth("auth.provider", "apps/web", 3)).toBeUndefined();
  });

  test("a policy is revoked like a slot is retracted: its value becomes null", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "policy:integrate|neg|*", scope: "", value: "in force" }], "user", at(1));
    oracle.apply([{ key: "policy:integrate|neg|*", scope: "", value: null }], "user", at(4));
    expect(oracle.truth("policy:integrate|neg|*", "apps/web", 3)?.value).toBe("in force");
    expect(oracle.truth("policy:integrate|neg|*", "apps/web", 4)?.value).toBeNull();
  });

  test("an effect outside the world is a fixture error", () => {
    const oracle = new Oracle(SUBJECTS);
    expect(() => oracle.apply([{ key: "db.engine", scope: "", value: "postgres" }], "user", at(0))).toThrow(
      "no subject db.engine",
    );
    expect(() => oracle.apply([{ key: "node.version", scope: "", value: "18" }], "user", at(0))).toThrow(
      "18 is not a value of node.version",
    );
    expect(() => new Oracle([SUBJECTS[0]!, SUBJECTS[0]!])).toThrow("defined twice");
  });
});

test("the values held at a scope and below it, each where it is set", () => {
  const oracle = new Oracle(SUBJECTS);
  oracle.apply([{ key: "auth.provider", scope: "apps/web", value: "Clerk" }], "user", at(1));
  oracle.apply([{ key: "auth.provider", scope: "packages/cli", value: "Auth0" }], "user", at(2));
  oracle.apply([{ key: "auth.provider", scope: "packages/cli", value: null }], "user", at(3));
  expect(oracle.within("auth.provider", "", 2)).toEqual([
    { scope: "apps/web", value: "Clerk" },
    { scope: "packages/cli", value: "Auth0" },
  ]);
  expect(oracle.within("auth.provider", "", 3)).toEqual([{ scope: "apps/web", value: "Clerk" }]);
  expect(oracle.within("auth.provider", "apps", 3)).toEqual([{ scope: "apps/web", value: "Clerk" }]);
  expect(oracle.within("auth.provider", "packages", 3)).toEqual([]);
  expect(oracle.within("auth.provider", "apps/web", 3)).toEqual([{ scope: "apps/web", value: "Clerk" }]);
});

describe("a rewind takes back what the abandoned prompts said", () => {
  test("the value before them returns, including a repo change made in between", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "auth.provider", scope: "", value: "Auth0" }], "repo", at(0));
    oracle.apply([{ key: "auth.provider", scope: "", value: "Clerk" }], "user", at(2), "prompt-a");
    oracle.apply([{ key: "node.version", scope: "", value: "22" }], "user", at(3), "prompt-b");
    oracle.apply([{ key: "node.version", scope: "", value: "20" }], "repo", at(4));
    oracle.abandon(new Set(["prompt-a", "prompt-b"]), at(6));
    expect(oracle.truth("auth.provider", "", 5)?.value).toBe("Clerk");
    expect(oracle.truth("auth.provider", "", 6)?.value).toBe("Auth0");
    // The repo's 20 came after the abandoned 22 and still stands.
    expect(oracle.truth("node.version", "", 6)?.value).toBe("20");
  });

  test("a value only an abandoned prompt set no longer holds", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "auth.provider", scope: "apps/web", value: "Clerk" }], "user", at(1), "prompt-a");
    oracle.abandon(new Set(["prompt-a"]), at(2));
    expect(oracle.truth("auth.provider", "apps/web", 2)).toEqual({ scope: "apps/web", value: null });
    expect(oracle.entries.at(-1)).toMatchObject({ key: "auth.provider", value: null, cause: "rewind", seq: 2 });
  });

  test("other prompts' values are untouched, and an abandon that changes nothing writes nothing", () => {
    const oracle = new Oracle(SUBJECTS);
    oracle.apply([{ key: "auth.provider", scope: "", value: "Clerk" }], "user", at(1), "prompt-a");
    const entries = oracle.entries.length;
    oracle.abandon(new Set(["prompt-z"]), at(2));
    expect(oracle.entries.length).toBe(entries);
    expect(oracle.truth("auth.provider", "", 2)?.value).toBe("Clerk");
  });
});

test("oracle.jsonl holds every change in order, with its cause and the event it holds from", () => {
  const oracle = new Oracle(SUBJECTS);
  oracle.apply([{ key: "node.version", scope: "", value: "20" }], "init", at(0));
  oracle.apply([{ key: "auth.provider", scope: "apps/web", value: "Clerk" }], "user", at(4), "u1");
  const path = join(tempDir("eden-oracle"), "oracle.jsonl");
  oracle.write(path);
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows).toEqual([
    { key: "node.version", scope: "", value: "20", seq: 0, t: 0, cause: "init" },
    { key: "auth.provider", scope: "apps/web", value: "Clerk", seq: 4, t: 4000, cause: "user", origin: "u1" },
  ]);
});
