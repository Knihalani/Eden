import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderAmbitiousResults, runAmbitiousCases, runH1Ablation } from "./cases";

const rows = await runAmbitiousCases();
const ab = await runH1Ablation();
const md = renderAmbitiousResults(rows) + [
  "",
  "## H1 ablation (Auth is Clerk → why is login broken?)",
  "",
  "| flag | Clerk in packet | silent |",
  "|---|---|---|",
  ...ab.map((r) => `| ${r.flag} | ${r.hit ? "yes" : "no"} | ${r.silent} |`),
  "",
].join("\n");
writeFileSync(join(import.meta.dir, "RESULTS.md"), md);
console.log(md);
