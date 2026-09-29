import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainMemory } from "../../src/brain-memory.ts"; // not-product
import { contentToks } from "../../src/cls/text.ts";
import { atomize, splitFacts, splitIcl } from "./atoms.ts";

describe("contentToks coerce", () => {
  test("non-string input does not throw", () => {
    expect(contentToks(null as unknown as string)).toEqual([]);
    expect(contentToks(12 as unknown as string).length).toBeGreaterThan(0);
  });
});

describe("atomize ICL", () => {
  const blob = `I've already tried 5 times to complete a transfer that's just standard. What's the deal? Is your system down at this time?
label: 73

I would like some more physical cards, what is my limit?
label: 71

Is there a top-up limit that I have to stay under during a given period of time?
label: 14

My disposable virtual card isn't working.
label: 28

Where is my virtual card
label: 46
`;

  test("splits one episode per labeled example", () => {
    const units = splitIcl(blob);
    expect(units.length).toBe(5);
    expect(units.find((u) => u.endsWith("label: 28"))).toContain("disposable virtual card");
    expect(atomize(blob).kind).toBe("icl");
  });
});

describe("atomize facts", () => {
  const blob = `Here is a list of facts:
0. Thomas Kyd was born in the city of London.
1. The chairperson of Fatah is Mahmoud Abbas.
2. Amy Winehouse died in the city of Camden Town.
3. Hines Ward plays the position of wide receiver.
4. Bengaluru is located in the continent of Asia.
5. Pedro Pierluisi worked in the city of Washington, D.C..
6. Rogério Ceni plays the position of goalkeeper.
7. Victoria Beckham is married to David Beckham.
8. The chairperson of Fatah is Alice Example.
`;

  test("keeps serial numbers", () => {
    const facts = splitFacts(blob);
    expect(facts.length).toBe(9);
    expect(facts[8]!.serial).toBe(8);
    expect(atomize(blob).kind).toBe("facts");
  });
});

describe("atomize recsys", () => {
  const movies = `1. Superbad (2007)
2. Super Troopers (2001)
3. Knocked Up (2007)
4. The Hangover (2009)
5. Superbad (2007)
6. Role Models (2008)
7. Pineapple Express (2008)
8. Forgetting Sarah Marshall (2008)
`;
  const redial = `You are a movie recommender. Here is the conversation:
User: I like Superbad (2007)
System: You might like Super Troopers (2001)
User: I watched Knocked Up (2007)
System: Try The Hangover (2009)
`;

  test("numbered movie lists are recsys packs, not fact serials", () => {
    const got = atomize(movies);
    expect(got.kind).toBe("recsys");
    expect(got.atoms.length).toBeGreaterThan(0);
    expect(got.atoms.some((a) => /Superbad \(2007\)/.test(a.text) && /Forgetting Sarah Marshall/.test(a.text))).toBe(true);
    expect(got.atoms.map((a) => a.session)).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(got.atoms.every((a) => !/^\d+\.\s+Superbad/.test(a.text) || got.atoms.length < 8)).toBe(true);
  });

  test("ReDial dialogue is recsys; chairperson list stays facts; ICL stays icl", () => {
    expect(atomize(redial).kind).toBe("recsys");
    expect(atomize(redial).atoms.some((a) => /User:/.test(a.text) && /Superbad/.test(a.text))).toBe(true);
    const chairs = `Here is a list of facts:
0. Thomas Kyd was born in the city of London.
1. The chairperson of Fatah is Mahmoud Abbas.
2. Amy Winehouse died in the city of Camden Town.
3. Hines Ward plays the position of wide receiver.
4. Bengaluru is located in the continent of Asia.
5. Pedro Pierluisi worked in the city of Washington, D.C..
6. Rogério Ceni plays the position of goalkeeper.
7. Victoria Beckham is married to David Beckham.
8. The chairperson of Fatah is Alice Example.
`;
    expect(atomize(chairs).kind).toBe("facts");
    const icl = `I've already tried 5 times to complete a transfer that's just standard. What's the deal? Is your system down at this time?
label: 73

I would like some more physical cards, what is my limit?
label: 71

Is there a top-up limit that I have to stay under during a given period of time?
label: 14

My disposable virtual card isn't working.
label: 28
`;
    expect(atomize(icl).kind).toBe("icl");
  });
});

describe("ICL retrieve hits the gold exemplar", () => {
  test("disposable-card query returns label 28 not 14", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-icl-"));
    const mem = new BrainMemory({ dir, cortex: false }); // not-product
    try {
      const { atoms } = atomize(`Is there a top-up limit that I have to stay under during a given period of time?
label: 14

How do I deposit through bank transfer?
label: 52

My disposable virtual card isn't working.
label: 28

should i add money via bank transfer instead
label: 76

I cannot get my google pay to work.
label: 30

Why isn't my purchase exchange rate correct?
label: 19

I got a message that my transfer was declined.
label: 29

I need my card ASAP!
label: 13
`);
      mem.ingestTurns(atoms.map((a) => ({ text: a.text, speaker: "User", session: a.session })));
      const got = mem.retrieve(
        "Are there restrictions for my disposable card since it does not seem to be working?",
        8,
        { neighbors: false, complete: false },
      ).join("\n");
      expect(got).toContain("label: 28");
      const withSemantic = mem.retrieve(
        "Are there restrictions for my disposable card since it does not seem to be working?",
        8,
        { neighbors: false },
      ).join("\n");
      expect(withSemantic).toContain("label: 28");
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("needle retrieve among filler", () => {
  test("unique sentence is in top-5 of a long haystack", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-needle-"));
    const mem = new BrainMemory({ dir, cortex: false }); // not-product
    try {
      const filler = Array.from({ length: 80 }, (_, i) => `The river flowed past village ${i} under a grey sky that week.`);
      const needle = "The password for the hidden vault is zebra-quark-17.";
      filler.splice(40, 0, needle);
      const { atoms } = atomize(filler.join(" "));
      mem.ingestTurns(atoms.map((a) => ({ text: a.text, speaker: "User", session: a.session })));
      const got = mem.retrieve("What is the password for the hidden vault?", 5).join("\n");
      expect(got).toContain("zebra-quark-17");
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stemmed synonym expand", () => {
  test("spouse query retrieves a married-to fact", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-spouse-"));
    const mem = new BrainMemory({ dir, cortex: false }); // not-product
    try {
      mem.ingestTurns([
        { text: "Charles Darwin is married to Amala Paul.", speaker: "User", session: 0 },
        { text: "Thomas Kyd was born in the city of London.", speaker: "User", session: 1 },
        { text: "Bengaluru is located in the continent of Asia.", speaker: "User", session: 2 },
      ]);
      const got = mem.retrieve("Who is Charles Darwin's spouse?", 4, { neighbors: false }).join("\n");
      expect(got).toContain("Amala Paul");
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("3-hop overwrite prefers the current graph", () => {
  test("citizen of spouse of overwritten author is Belgium, not the UK", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-hop-"));
    const mem = new BrainMemory({ dir, cortex: false }); // not-product
    try {
      const { atoms } = atomize(`0. The author of Our Mutual Friend is Charles Dickens.
1. Charles Darwin is married to Emma Darwin.
2. Emma Darwin is a citizen of the United Kingdom.
3. The author of Our Mutual Friend is Charles Darwin.
4. Charles Darwin is married to Amala Paul.
5. Amala Paul is a citizen of Belgium.
6. Thomas Kyd was born in the city of London.
7. Hines Ward plays the position of wide receiver.
`);
      mem.ingestTurns(atoms.map((a) => ({ text: a.text, speaker: "User", session: a.session })));
      const got = mem.retrieve(
        "Which country is the spouse of the author of Our Mutual Friend a citizen of?",
        8,
        { neighbors: false },
      );
      expect(got[0]).toContain("Belgium");
      expect(got[0]).not.toMatch(/United Kingdom|Dickens/);
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fact overwrite newest wins", () => {
  test("later chairperson fact ranks over the earlier one", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-fact-"));
    const mem = new BrainMemory({ dir, cortex: false }); // not-product
    try {
      const { atoms } = atomize(`0. Thomas Kyd was born in the city of London.
1. The chairperson of Fatah is Mahmoud Abbas.
2. Amy Winehouse died in the city of Camden Town.
3. Hines Ward plays the position of wide receiver.
4. Bengaluru is located in the continent of Asia.
5. Pedro Pierluisi worked in the city of Washington, D.C..
6. Rogério Ceni plays the position of goalkeeper.
7. Victoria Beckham is married to David Beckham.
8. The chairperson of Fatah is Alice Example.
`);
      mem.ingestTurns(atoms.map((a) => ({ text: a.text, speaker: "User", session: a.session })));
      const got = mem.retrieve("Who is the chairperson of Fatah?", 6, { neighbors: false }).join("\n");
      expect(got).toContain("Alice Example");
    } finally {
      mem.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
