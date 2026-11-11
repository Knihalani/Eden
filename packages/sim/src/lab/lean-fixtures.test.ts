import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPacket } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";

// E1 (D1032, docs/research/e1-lean.md): `leanItems` drops boilerplate with fixed rules. The short constraint items
// M3r and M7 wrote by hand (and M2's generated ones in m3r's file) are where a rule that cut a fact would show: each is
// rendered plain, then wrapped in the boilerplate of several writing styles and rendered lean, and every word of the
// plain line must still be there.

const LAB = join(import.meta.dir, "../../lab");
const short = readFileSync(join(LAB, "m3r/short-constraints.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { title: string; text: string });
const m7 = JSON.parse(readFileSync(join(LAB, "m7/fixtures.json"), "utf8")) as {
  cases: { request: string; item: { title: string; from: string; text: string } }[];
  background: { title: string; from: string; text: string }[];
};
const FIXTURES = [
  ...short.map((x) => ({ ...x, from: "Sam Ortiz", request: "" })),
  ...m7.cases.map((c) => ({ ...c.item, request: c.request })),
  ...m7.background.map((x) => ({ ...x, request: "" })),
];

const STYLES: { name: string; wrap: (text: string, from: string) => string; gone: string[] }[] = [
  {
    name: "mail with courtesy and sign-off",
    wrap: (t, f) =>
      `From: ${f}\nDate: Mon 26 Oct 2026 09:00\n${t}\nHappy to jump on a call if easier.\n${f.split(" ")[0]}`,
    gone: ["Happy to jump"],
  },
  {
    name: "signature run into a disclaimer",
    wrap: (t, f) => `${t} — ${f} CONFIDENTIALITY NOTICE: This email and any attachments are confidential.`,
    gone: ["CONFIDENTIALITY", "attachments"],
  },
  {
    name: "notification footer",
    wrap: (t) => `${t}\nReply to this email directly or view it on GitHub.\nTo change which emails you receive, visit…`,
    gone: ["Reply to this email", "change which emails"],
  },
  {
    name: "regulatory footer",
    wrap: (t) => `${t}\nNorthgate Bank plc is authorised by the Prudential Regulation Authority.`,
    gone: ["Prudential"],
  },
];

const WORDS = /[\p{L}\p{N}£$€%]+/gu;
const words = (s: string) => new Set(s.toLowerCase().match(WORDS) ?? []);
const lineOf = (text: string, title: string, request: string, lean: boolean) => {
  const item: ContextItem = { id: "x:1", sourceId: "x", ref: "1", title, text, updatedAt: 0 };
  const focus = words(request);
  const out = renderPacket([item], { maxBytes: 8_000, focus, itemBytes: 4_000, year: 2026, dense: true, lean });
  return out.split("\n").find((l) => l.startsWith("- [")) ?? "";
};

describe("leanItems keeps every word of the hand-written and generated short constraints", () => {
  test(`${FIXTURES.length} fixtures are read`, () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(60);
  });
  for (const style of STYLES) {
    test(style.name, () => {
      for (const f of FIXTURES) {
        const plain = lineOf(f.text, f.title, f.request, false);
        const lean = lineOf(style.wrap(f.text, f.from), f.title, f.request, true);
        const have = words(lean);
        const missing = [...words(plain)].filter((w) => !have.has(w));
        expect({ title: f.title, missing }).toEqual({ title: f.title, missing: [] });
        for (const g of style.gone) expect(lean).not.toContain(g);
      }
    });
  }
});
