import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INJECT_FACTS, INJECT_ROWS } from "../../../.gauntlet/inject";
import { encodePack } from "./pack";
import { openStore } from "./store";
import { detectNeed } from "./need";
import { injectFromRequest, injectFromText, subjectMentioned } from "./inject";
import { implicitTechniqueTask, techniqueNeedleFromText, techniqueQueryFallbacks } from "./needles";

function packed() {
  const dir = mkdtempSync(join(tmpdir(), "eden-know-need-"));
  writeFileSync(join(dir, "graph.kpk"), encodePack(INJECT_FACTS));
  return { dir, store: openStore(dir) };
}

function fact(card: { fact: string } | undefined): string {
  return card?.fact ?? "";
}

describe("need detect POC", () => {
  test("implicit technique fires without “best way”; media-type English does not", () => {
    expect(implicitTechniqueTask("parse this CLI JSON output")).toBe("JSON");
    expect(implicitTechniqueTask("run TypeScript services")).toBe("TypeScript");
    expect(implicitTechniqueTask("the json media type from IANA")).toBeUndefined();
    expect(implicitTechniqueTask("Set Content-Type to application/json")).toBeUndefined();
    expect(techniqueNeedleFromText("parse this CLI JSON output")).toBe("used for JSON");
    expect(implicitTechniqueTask("pretty-print this NDJSON stream")).toBe("JSON");
    expect(implicitTechniqueTask("I need to parse nested JSON in bash")).toBe("JSON");
    expect(implicitTechniqueTask("trying to filter JSON on the command line")).toBe("JSON");
    expect(implicitTechniqueTask("pull the nested ids from payload.json")).toBe("JSON");
    expect(implicitTechniqueTask("pip install the Python packages")).toBe("Python");
    expect(implicitTechniqueTask("find files by name in the tree")).toBe("files");
    expect(implicitTechniqueTask("npm install python")).toBeUndefined();
    expect(implicitTechniqueTask("pip install requests")).toBe("Python");
    expect(implicitTechniqueTask("find a file named tsconfig")).toBe("files");
    expect(implicitTechniqueTask("find . -name '*.ts' in the tree")).toBe("files");
    expect(implicitTechniqueTask("execute TypeScript services directly")).toBe("TypeScript");
    expect(implicitTechniqueTask("run tsx without a compile step")).toBe("TypeScript");
    expect(implicitTechniqueTask("Parse JSON with RFC 8259.")).toBeUndefined();
    expect(implicitTechniqueTask("parse application/json")).toBeUndefined();
    expect(implicitTechniqueTask("run Python")).toBeUndefined();
    expect(implicitTechniqueTask("bundle TypeScript")).toBeUndefined();
    expect(implicitTechniqueTask("runs TypeScript services without a compile step")).toBe("TypeScript");
    expect(implicitTechniqueTask("easy_install flask")).toBe("Python");
    expect(implicitTechniqueTask("we installed Python last year; please refactor")).toBeUndefined();
    expect(techniqueNeedleFromText("what's the best way to parse JSON with RFC 8259")).toBeUndefined();
    expect(techniqueNeedleFromText("what should I use for installing Python packages with bun")).toBeUndefined();
    expect(detectNeed({ text: "grep the json media type from IANA" }).queries).not.toContain("used for JSON");
    expect(implicitTechniqueTask("I have a JSON pipeline and need nested keys")).toBe("JSON");
    expect(detectNeed({ text: "Parse the body with RFC 4627." }).queries[0]).toBe("RFC 8259 obsoletes");
    expect(detectNeed({ text: "Parse the body with RFC-4627." }).queries[0]).toBe("RFC 8259 obsoletes");
    expect(detectNeed({ text: "Follow RFC 3986 when parsing the URI." }, { skipIdent: true }).silent).toBe(true);
    expect(detectNeed({ text: "Set Content-Type to application/json", tools: ["Grep"] }).queries).not.toContain(
      "used for JSON",
    );
    expect(
      detectNeed({ text: "Set Content-Type to application/json", tools: ["Grep"] }, { skipIdent: true }).silent,
    ).toBe(true);
    expect(detectNeed({ text: "grep the json media type from IANA" }).queries).not.toContain("used for JSON");
    expect(detectNeed({ text: "Does RFC 9110 update RFC 7230 or obsolete it?" }).queries[0]).toBe("RFC 9110 obsoletes");
  });

  test("labeled corpus: silent set stays empty; typed/technique/wrong hit the named card", () => {
    const { dir, store } = packed();
    try {
      let silentOk = 0;
      let silentN = 0;
      let hitOk = 0;
      let hitN = 0;
      const misses: string[] = [];
      for (const row of INJECT_ROWS) {
        const card = injectFromRequest({ text: row.text, tools: row.tools, calls: row.calls }, store);
        const got = fact(card);
        if (row.want === "silent") {
          silentN++;
          if (!got) silentOk++;
          else misses.push(`${row.id}: wanted silent got ${got}`);
        } else {
          hitN++;
          if (row.want.test(got)) hitOk++;
          else misses.push(`${row.id}: wanted ${row.want} got ${got || "<silent>"}`);
        }
      }
      expect(misses, misses.join("\n")).toEqual([]);
      expect(silentOk).toBe(silentN);
      expect(hitOk).toBe(hitN);
      expect(silentN).toBeGreaterThan(0);
      expect(hitN).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detectNeed names the query before inject; tools[] descriptions are not in text", () => {
    const d = detectNeed({
      text: "extract nested ids from the payload",
      tools: ["Grep"],
      calls: [{ name: "Grep", args: "path=payload.json pattern=.items[]" }],
    });
    expect(d.silent).toBe(false);
    expect(d.kind).toBe("wrong");
    expect(d.queries[0]).toBe("used for JSON");
    expect(detectNeed({ text: "Please refactor the auth middleware and add a log line." }).silent).toBe(true);
  });

  test("injectFromText still uses the request path", () => {
    const { dir, store } = packed();
    try {
      expect(fact(injectFromText("parse this CLI JSON output into records", store))).toMatch(/^jq is used for/);
      expect(injectFromText("use jq to filter JSON on the command line", store)).toBeUndefined();
      expect(subjectMentioned("use jq to filter JSON", "jq is used for filtering JSON on the command line.")).toBe(
        true,
      );
      expect(subjectMentioned("use rg to search the repo", "ripgrep is used for searching the repo.")).toBe(true);
      expect(subjectMentioned("parse nested JSON", "jq is used for filtering JSON on the command line.")).toBe(false);
      expect(subjectMentioned("Is RFC 9110 the successor to RFC 7230?", "RFC 9110 obsoletes RFC 7230.")).toBe(false);
      expect(subjectMentioned("use bunx to run TypeScript", "Bun is used for running TypeScript services.")).toBe(true);
      expect(subjectMentioned("Follow RFC 9110 for HTTP.", "RFC 9110 obsoletes RFC 7230.")).toBe(true);
      expect(techniqueQueryFallbacks("used for installing JavaScript packages")).not.toContain("used for installing");
      expect(techniqueQueryFallbacks("used for installing Python packages")).toContain("used for installing Python");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("current successor RFCs do not open the pack; cold stale numbers still do", () => {
    const { dir, store } = packed();
    const inner = store.search.bind(store);
    let n = 0;
    const wrapped = {
      search(q: string, k?: number) {
        n++;
        return inner(q, k);
      },
      close: () => store.close(),
    };
    try {
      expect(injectFromRequest({ text: "Follow RFC 3986 when parsing the URI." }, wrapped)).toBeUndefined();
      expect(n).toBe(0);
      n = 0;
      expect(fact(injectFromRequest({ text: "Follow RFC 1111 for the handshake." }, wrapped))).toMatch(
        /RFC 9998 obsoletes RFC 1111/,
      );
      expect(n).toBeGreaterThan(0);
      n = 0;
      expect(
        fact(
          injectFromRequest(
            { text: "RFC 3986, RFC 9110, RFC 8259, RFC 8446, then RFC 1111 for the handshake." },
            wrapped,
          ),
        ),
      ).toMatch(/RFC 9998 obsoletes RFC 1111/);
      expect(n).toBeGreaterThan(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
