import { describe, expect, test } from "bun:test";
import { atomize, splitFacts, splitIcl } from "./atoms.ts";

describe("atomize ICL", () => {
  const blob = `I've already tried 5 times to complete a transfer that's just standard. What's the deal? Is your \
system down at this time?
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
    expect(got.atoms.some((a) => /Superbad \(2007\)/.test(a.text) && /Forgetting Sarah Marshall/.test(a.text))).toBe(
      true,
    );
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
    const icl = `I've already tried 5 times to complete a transfer that's just standard. What's the deal? Is your \
system down at this time?
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
