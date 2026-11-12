import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { glossOf, languagesOf, loadGlossary, MAX_GLOSS_WORDS } from "./gloss";

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
