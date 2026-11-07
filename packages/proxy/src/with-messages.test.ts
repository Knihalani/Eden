import { describe, expect, test } from "bun:test";
import { withMessages } from "./proxy";

// Audit A5: injecting re-serialised the whole body; now only `messages` is replaced, every other byte kept.
describe("withMessages", () => {
  const m = [{ role: "user", content: "hi" }];
  test("keeps every other byte, a 64-bit integer included", () => {
    const raw = '{ "model" : "x", "seed": 12345678901234567890 ,\n "messages" : [ {"role":"user"} ] , "n":1 }';
    const out = withMessages(raw, m)!;
    expect(out).toBe(
      '{ "model" : "x", "seed": 12345678901234567890 ,\n "messages" : ' + JSON.stringify(m) + ' , "n":1 }',
    );
  });
  test("a nested or quoted `messages` is not the top-level one; the last top-level key wins", () => {
    const raw = '{"meta":{"messages":[1]},"note":"\\"messages\\": [2]","messages":[3],"messages":[4]}';
    const out = withMessages(raw, m)!;
    expect(JSON.parse(out)).toEqual({ meta: { messages: [1] }, note: '"messages": [2]', messages: m });
    expect(out.startsWith('{"meta":{"messages":[1]},"note":"\\"messages\\": [2]","messages":[3],')).toBe(true);
  });
  test("no top-level messages: null", () => {
    expect(withMessages('{"model":"x","x":{"messages":[]}}', m)).toBeNull();
  });
  test("parses to the same object as replacing the parsed field, over generated bodies", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const value = (d: number): unknown => {
      const r = rnd();
      if (d > 3 || r < 0.3) return [1, 'a"b\\\\c', true, null, 2.5, "messages"][Math.floor(rnd() * 6)];
      if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 3) }, () => value(d + 1));
      return Object.fromEntries(Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => [`k${i}`, value(d + 1)]));
    };
    for (let n = 0; n < 300; n++) {
      const body = { model: "x", a: value(0), messages: value(0), b: value(0) };
      const raw = JSON.stringify(body, null, rnd() < 0.5 ? 1 : 0);
      expect(JSON.parse(withMessages(raw, m)!)).toEqual({ ...body, messages: m });
    }
  });
});
