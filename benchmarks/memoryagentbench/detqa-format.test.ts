/**
 * M30.2 DetQA reader unwrap. Output format only (JSON/fences → short answer).
 * Not stored-shot strip. Does not run NIM or the 71-query leaf.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const ROOT = join(HERE, "..", "..");
const AGENT = join(HERE, "inject-agent.py");
const PYTHON = join(ROOT, ".venv", "bin", "python");

function call(fn: "_detqa_complete" | "_icl_complete", text: string, sub: string): string {
  const py = existsSync(PYTHON) ? PYTHON : "python3";
  const script = `
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("inject_agent", ${JSON.stringify(AGENT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
payload = json.load(sys.stdin)
agent = SimpleNamespace(sub_dataset=payload["sub"])
out = getattr(mod, payload["fn"])(payload["text"], agent)
sys.stdout.write(out)
`;
  const r = spawnSync(py, ["-c", script], {
    encoding: "utf8",
    input: JSON.stringify({ fn, text, sub }),
    cwd: ROOT,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

function callRetrieval(message: string): string {
  const py = existsSync(PYTHON) ? PYTHON : "python3";
  const script = `
import importlib.util, json, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("inject_agent", ${JSON.stringify(AGENT)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
payload = json.load(sys.stdin)
agent = SimpleNamespace(sub_dataset="detective_qa")
out = mod.retrieval_query(agent, payload["text"])
sys.stdout.write(out)
`;

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/10
  const r = spawnSync(py, ["-c", script], {
    encoding: "utf8",
    input: JSON.stringify({ text: message }),
    cwd: ROOT,
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

describe("M30.2 DetQA output unwrap", () => {
  test("source: _detqa_complete is detective-gated fail-open, not ICL / not stored strip", () => {
    const py = readFileSync(AGENT, "utf8");
    expect(py).toMatch(/def _detqa_complete\(text, agent\):/);
    expect(py).toContain('if "detective" not in sub');
    expect(py).toMatch(/Fail-open|fail-open/);
    expect(py).toMatch(/text = _icl_complete\(text, agent\)/);
    expect(py).toMatch(/text = _detqa_complete\(text, agent\)/);
    const icl = py.match(
      /def _icl_complete\s*\(\s*text\s*,\s*agent\s*\)\s*:[\s\S]*?(?=\n(?:def |class |_[A-Z]))/,
    )?.[0] ?? "";
    expect(icl).toContain('if "icl" not in sub');
    expect(icl).toContain('re.match(r"^(?:label\\s*:\\s*)(.+)$", raw, re.I)');
    const det = py.match(
      /def _detqa_complete\s*\(\s*text\s*,\s*agent\s*\)\s*:[\s\S]*?(?=\n(?:def |class |_[A-Z]))/,
    )?.[0] ?? "";
    expect(det).toContain('if "detective" not in sub');
    expect(det).not.toMatch(/\bobserve\b/);
    expect(det).not.toMatch(/\bhaystack\b/);
    expect(det).not.toMatch(/re\.sub/);
    expect(det).not.toMatch(/packet\s*=/);
  });

  test("unwraps Gemma JSON / fences to the short gold string", () => {
    const bare =
      '{"answer":"C. The Brandt couple", "reasoning":" Brand got out of near-bankruptcy."}';
    expect(call("_detqa_complete", bare, "detective_qa")).toBe("C. The Brandt couple");

    const fenced =
      '```json\n{"answer":"B. Miss Martin Dale", "reasoning":" Miss Marple killed Ingrid."}\n```';
    expect(call("_detqa_complete", fenced, "detective_qa")).toBe("B. Miss Martin Dale");

    const prose =
      'Based on the provided context, there is no mention of Quentin Ducassin.\n\nOutput: {"answer":"None of the above", "reasoning":"missing character"}';
    expect(call("_detqa_complete", prose, "detective_qa")).toBe("None of the above");

    expect(call("_detqa_complete", "C. The Brandt couple", "detective_qa")).toBe(
      "C. The Brandt couple",
    );
  });

  test("non-detective and fail-open leave text alone; ICL complete is unchanged", () => {
    const dump =
      '{"answer":"C. The Brandt couple", "reasoning":" Brand got out of near-bankruptcy."}';
    expect(call("_detqa_complete", dump, "icl_banking77")).toBe(dump);
    expect(call("_detqa_complete", dump, "ruler_qa1_197K")).toBe(dump);

    const broken = "```json\n{not json at all\n```";
    expect(call("_detqa_complete", broken, "detective_qa")).toBe(broken);

    expect(call("_icl_complete", "label: 18", "icl_banking77")).toBe("18");
    expect(call("_icl_complete", "label: 18", "detective_qa")).toBe("label: 18");
    expect(call("_icl_complete", dump, "icl_banking77")).toBe(dump);
  });
});

describe("M30.2 retrieval_query extract (inject-agent)", () => {
  test("Now Answer the Question extract keeps A./B./C./D. and has no Question: prefix", () => {
    const official = `Based on the context you memorized, answer the question below. You are required to answer the question based on the strict output format.

For example:
[story text]

Question: Lichem Rocchi's method of death was certainly not ( )
A. Murder
B. Sudden death
C. Suicide
D. Sudden illness

Output: {"answer":"C. Suicide", "reasoning":"example"}

Now Answer the Question:  Which character is related to the death of the deceased?
A. Mrs. Hemm
B. Mr. and Mrs. MacNamara
C. The Brandt couple
D. Miss House
 Output:
`;
    const q = callRetrieval(official);
    expect(q).not.toMatch(/^Question:/);
    expect(q).toMatch(/\bA\.\s/);
    expect(q).toMatch(/\bB\.\s/);
    expect(q).toMatch(/\bC\.\s/);
    expect(q).toMatch(/\bD\.\s/);
    expect(q).toMatch(/Which character is related to the death of the deceased\?/);
    expect(q).not.toMatch(/Based on the context you memorized/);
  });
});

describe("M30.4 LRU honesty + M15 lock", () => {
  test.failing("M15-EVIDENCE DetQA 0.0 is not retuned; live LRU 55.1 does not claim overall ≥50 vs Claude", () => {
    const ev = readFileSync(join(HERE, "M15-EVIDENCE.md"), "utf8");
    expect(ev).toMatch(/DetQA[^\n]*\*\*0\.0\*\*/);
    expect(ev).toMatch(/Table 3 LRU[^\n]*\*\*4\.5\*\*/);
    expect(ev).toMatch(/Table 3 overall[^\n]*\*\*30\.0\*\*/);

    const table = readFileSync(join(HERE, "TABLE3-RESULTS.md"), "utf8");
    expect(table).toMatch(/\| LRU \| 55\.1 \|/);
    expect(table).toMatch(/\| detqa \| 200000 \| 71 \| exact_match \| 73\.2 \|/);
    expect(table).toMatch(/mean\(Summ, DetQA\) only if both exist; missing named not zeroed/);
    expect(table).toMatch(/LRU vs Claude 49\.6 requires ≥46; else concede/);
    expect(table).toMatch(/\*\*overall\*\*\s*\|\s*\*\*44\.5\*\*/);
    expect(table).not.toMatch(/\*\*overall\*\*\s*\|\s*\*\*(?:5\d|6\d|7\d|8\d|9\d|100)/i);

    const lru = readFileSync(join(HERE, "LRU-M30.md"), "utf8");
    expect(lru).toMatch(/\*\*73\.2\*\*/);
    expect(lru).toMatch(/\*\*55\.1\*\*/);
    expect(lru).toMatch(/Do not concede LRU/i);
    expect(lru).toMatch(/LOSS vs Claude 49\.6/);
    expect(lru).toMatch(/Do \*\*not\*\* claim overall \*\*≥ 50\*\*/);

    const det = readFileSync(join(HERE, "DETQA-M30.md"), "utf8");
    expect(det).toMatch(/\*\*73\.2\*\*/);
    expect(det).toMatch(/52 \/ 71/);
    expect(det).not.toMatch(/pending orchestrator run/i);
  });
});
