import { readFileSync } from "node:fs";
import { dayFactsClass, dayFactsOf } from "../../../engine/src/day-facts";
import { coversDay, datedText, dayKeys } from "../../../engine/src/days";
import { timeWindow } from "../../../engine/src/grounding";

for (const f of process.argv.slice(2)) {
  const d = JSON.parse(readFileSync(f, "utf8"));
  const dt = datedText(d.req, d.now, 0);
  const days = timeWindow(dt, d.now, 0)?.days ?? new Set<string>();
  const facts = dayFactsOf(d.title, d.text);
  console.log(
    f.split("/").pop(),
    "| req days",
    [...days],
    "| item class",
    dayFactsClass(facts, days, dayKeys(days), d.at),
    "| covers",
    coversDay(d.text, days, d.at),
  );
}
