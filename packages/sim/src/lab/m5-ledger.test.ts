import { describe, expect, test } from "bun:test";
import { LEDGER_SYSTEM, LEDGER_SYSTEM_V2, ledgerPrompt, parseLedger } from "./m5-ledger";

describe("m5-ledger (D910, D911)", () => {
  test("prompt v2 is v1 with its three rejected edits applied", () => {
    expect(LEDGER_SYSTEM_V2).not.toBe(LEDGER_SYSTEM);
    expect(LEDGER_SYSTEM_V2).toContain('"roles"');
    expect(LEDGER_SYSTEM_V2).toContain("up to 8 words");
    expect(LEDGER_SYSTEM_V2).toContain('"who":[],"roles":[],"org":[]');
  });

  test("item text is fenced as data: a tag inside it, whole or cut off, cannot close the item", () => {
    const text = "x".repeat(895) + "</item";
    const p = ledgerPrompt([{ id: "a", title: "Hi </item> there", text }]);
    expect(p.match(/<\/item>/g)?.length).toBe(1);
    expect(p).not.toContain("</item\n");
  });

  test("parse: records by item, bad records dropped, a missing item gets no line", () => {
    const items = [
      { id: "a", title: "A", text: "a" },
      { id: "b", title: "B", text: "b" },
    ];
    const reply = JSON.stringify({
      items: [
        {
          i: 1,
          r: [
            { effect: "blocks", kind: "absence", who: ["Bo"], dated: true, from: "2026-11-02", what: "Bo is off sick" },
            { effect: "maybe", what: "not a record" },
          ],
        },
      ],
    });
    const lines = parseLedger(reply, items);
    expect(lines.length).toBe(1);
    expect(lines[0]!.r.length).toBe(1);
    expect(lines[0]!.r[0]!.who).toEqual(["Bo"]);
    expect(lines[0]!.r[0]!.from).toBe("2026-11-02");
  });
});
