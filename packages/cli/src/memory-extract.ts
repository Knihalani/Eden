/**
 * `eden memory extract --jsonl -` (P2.1): D9's write-time extraction, as the `extraction` arm reads it (A5 E3). Each
 * stdin line `{"id", "text"}` is answered by one line `{"id", "records"}`, with each text's pasted spans stripped first
 * (D12). A record is `{kind: "policy" | "intent", class, polarity, object, qualifier?}`. Slot records wait for D7's
 * slot table (P3.3). Nothing is read from or written to a store.
 */
import { extractRules } from "../../../src/memory-policy";

/** One answer line per input line; a line that is not a JSON object with a string `text` gets no records. */
export function extractJsonl(input: string): string {
  return input
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      let row: { id?: unknown; text?: unknown } = {};
      try {
        row = JSON.parse(line) as typeof row;
      } catch {}
      const rules = typeof row.text === "string" ? extractRules(row.text) : [];
      const records = rules.map(({ kind, class: cls, polarity, object, qualifier }) => ({
        kind,
        class: cls,
        polarity,
        object,
        ...(qualifier ? { qualifier } : {}),
      }));
      return `${JSON.stringify({ id: row.id ?? null, records })}\n`;
    })
    .join("");
}

export async function memoryExtractCli(args: string[]): Promise<number> {
  if (!(args.includes("--jsonl") && args.includes("-"))) {
    console.log('usage: eden memory extract --jsonl -   (stdin: {"id", "text"} per line)');
    return 0;
  }
  process.stdout.write(extractJsonl(await Bun.stdin.text()));
  return 0;
}
