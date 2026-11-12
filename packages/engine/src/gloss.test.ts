import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { glossOf, languagesOf, loadGlossary, MAX_GLOSS_WORDS, warmGlossary } from "./gloss";

const packed = {
  v: 1,
  langs: {
    it: {
      fn: ["voglio", "dai", "al", "il", "di"],
      tsv: ["conto\taccount", "corrente\tcurrent", "risparmi\tsaving", "spostare\tmove shift", "sterline\tpound"].join(
        "\n",
      ),
    },
    nl: { fn: ["ik", "een", "naar", "wil", "van"], tsv: ["rekening\tbill account", "telefoon\tphone"].join("\n") },
    pt: { fn: ["de", "um", "para", "preciso", "o"], tsv: "voo\tflight" },
  },
};
const file = join(mkdtempSync(join(tmpdir(), "gloss-")), "gloss.bin");
writeFileSync(file, gzipSync(JSON.stringify(packed)));
const langs = loadGlossary(file)!;

describe("glossOf", () => {
  test("glosses a request in a language the glossary holds", () => {
    expect(glossOf("Domani voglio spostare 5.000 sterline dai risparmi al conto corrente.", langs)).toBe(
      "move shift pound saving account current",
    );
  });

  test("an English request is left alone, even with a word another language shares", () => {
    expect(glossOf("Move £5,000 from my savings to the current account", langs)).toBe("");
    expect(languagesOf(["book", "a", "flight", "to", "porto", "de"], langs)).toEqual([]);
  });

  test("splits a compound of two known words in a compounding language", () => {
    expect(glossOf("Ik wil een opdracht naar pap voor zijn telefoonrekening", langs)).toBe("phone bill account");
  });

  test("a word only one of the tied languages knows still counts", () => {
    expect(languagesOf(["preciso", "de", "um", "voo"], langs)).toEqual(["pt"]);
    expect(glossOf("Preciso de um voo para Toronto", langs)).toBe("flight");
  });

  test("bounded, and fails open with no glossary", () => {
    const many = {
      v: 1,
      langs: {
        it: {
          fn: ["il", "di"],
          tsv: Array.from({ length: 40 }, (_, i) => `w${"a".repeat(i + 1)}\tx${"b".repeat(i + 1)}`).join("\n"),
        },
      },
    };
    const f = join(mkdtempSync(join(tmpdir(), "gloss-")), "gloss.bin");
    writeFileSync(f, gzipSync(JSON.stringify(many)));
    const text = `il di ${Array.from({ length: 40 }, (_, i) => `w${"a".repeat(i + 1)}`).join(" ")}`;
    expect(glossOf(text, loadGlossary(f)).split(" ").length).toBe(MAX_GLOSS_WORDS);
    expect(loadGlossary("/nonexistent/gloss.bin")).toBeNull();
    expect(glossOf("Voglio spostare il conto", null)).toBe("");
  });
});

describe("glossOf on the shipped glossary", () => {
  const shipped = warmGlossary();

  test("loads", () => {
    expect(shipped?.langs.size).toBeGreaterThanOrEqual(8);
  });

  // The review's probes (F1): English requests about foreign names, places and dishes stay English.
  test.each([
    "Email Jean-Pierre about the dinner at Café du Monde et la Gare on Friday.",
    "Pay the van der Berg invoice for the extension and copy Pieter van den Heuvel.",
    "Forward the Los Angeles del Mar contract to Maria dos Santos e Silva.",
    "Ask Giuseppe di Napoli about la dolce vita catering for the launch.",
    "Send the menu: coq au vin, pain au chocolat, crème brûlée to the chef for the Saturday wedding reception.",
    "Book a table at Le Petit Bistro for Anna and Jens on Thursday.",
  ])("an English request with foreign names is not glossed: %s", (text) => {
    expect(glossOf(text, shipped)).toBe("");
  });

  test.each([
    ["Domani voglio spostare 5.000 sterline dai risparmi al conto corrente.", "move"],
    ["Preciso de um canalizador pela Fixhub para ver a fuga debaixo do lava-loiça da cozinha.", "plumber"],
    ["Ich muss heute die Rechnung des Küchenbauers über £1,450 vom gemeinsamen Konto bezahlen.", "pay"],
    ["Je voudrais annuler la réservation pour demain soir.", "reservation"],
  ])("a non-English request is glossed: %s", (text, word) => {
    expect(glossOf(text, shipped).split(" ")).toContain(word);
  });

  test("decomposed accents read as composed ones", () => {
    const nfc = "Je voudrais annuler la réservation pour demain soir.";
    expect(glossOf(nfc.normalize("NFD"), shipped)).toBe(glossOf(nfc, shipped));
  });

  test("a glossary that parses but reads wrong is no glossary", () => {
    const f = join(mkdtempSync(join(tmpdir(), "gloss-")), "gloss.bin");
    writeFileSync(f, gzipSync(JSON.stringify({ v: 1, langs: { it: { fn: ["il"], tsv: 7 } } })));
    expect(loadGlossary(f)).toBeNull();
    writeFileSync(f, gzipSync(JSON.stringify({ v: 2, langs: {} })));
    expect(loadGlossary(f)).toBeNull();
  });
});
