/**
 * F3 (D1125): the subagent-simulated pilot's prompts, at $0. Each task's single-shot agent turn, as pi-ab's packet
 * arm would send it with no tools: the system prompt (data pushed, house rules), then Eden's push packets and the
 * request in the user turn. One line a distinct prompt (identical prompts across arms are answered once, so they
 * differ by nothing), and a map from (arm, task) to the prompt. Sim data only.
 *
 *   bun packages/sim/lab/f3/pilot-build.ts .local/f3/pilot [arm…]   # reads <arm>.packets.jsonl there (base CH CW)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { systemPrompt } from "../../src/lab/ab-common";
import { buildWorld } from "../../src/world";

const dir = process.argv[2]!;
// Arms: the packet dumps `<dir>/<arm>.packets.jsonl` to read (default: D1125's three).
const arms = process.argv.length > 3 ? process.argv.slice(3) : ["base", "CH", "CW"];
const prompts = new Map<string, { id: string; system: string; user: string }>();
const tasks: Record<string, unknown>[] = [];
const sys = new Map<number, string>();
for (const arm of arms) {
  for (const line of readFileSync(`${dir}/${arm}.packets.jsonl`, "utf8").trim().split("\n")) {
    const x = JSON.parse(line);
    const system =
      sys.get(x.seed) ??
      sys
        .set(
          x.seed,
          systemPrompt(buildWorld({ seed: x.seed * 1_000 }), {
            lookups: false,
            data: false,
            pushed: true,
            tenant: true,
          }),
        )
        .get(x.seed)!;
    const packets = (x.packets as { text: string }[]).map((p) => p.text);
    const user = [...packets, x.request].join("\n\n");
    const id = createHash("sha256").update(`${system}\u0000${user}`).digest("hex").slice(0, 12);
    if (!prompts.has(id)) prompts.set(id, { id, system, user });
    const planted = x.planted as string;
    const handed = (x.packets as { ids: string[] }[]).some((p) => p.ids.includes(planted));
    tasks.push({
      arm,
      suite: x.suite,
      seed: x.seed,
      variant: x.variant,
      template: x.template,
      request: x.request,
      detail: x.detail,
      planted,
      handed,
      chars: packets.join("").length,
      changeLines: packets.join("\n").split("changed at its source").length - 1,
      prompt: id,
    });
  }
}
writeFileSync(`${dir}/prompts.jsonl`, [...prompts.values()].map((p) => JSON.stringify(p)).join("\n") + "\n");
writeFileSync(`${dir}/tasks.jsonl`, tasks.map((t) => JSON.stringify(t)).join("\n") + "\n");
console.log(`${prompts.size} distinct prompts for ${tasks.length} arm-tasks`);
