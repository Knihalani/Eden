/**
 * `eden memory extract --jsonl -` (P2.1, P3.3): the write-time extraction, as the `extraction` arm reads it (A5 E3).
 * Each stdin line `{"id", "text"}` is answered by one line `{"id", "records"}`, with each text's pasted spans stripped
 * first (D12). A record is a slot's (D7): `{kind: "slot", slot, op: "set" | "invalidate", value}`, one per value a
 * statement sets or invalidates; or a rule's (D9): `{kind: "policy" | "intent", class, polarity, object, qualifier?}`.
 * Nothing is read from or written to a store.
 */
import { extractRules } from "../../../src/memory-policy";
import { extractSlots, type SlotStatement } from "../../../src/memory-slots";

/** A slot statement's records: the value it sets, then each value it invalidates. */
function slotRecords({ slot, value, was }: SlotStatement) {
  return [
    ...(value === undefined ? [] : [{ kind: "slot", slot, op: "set", value }]),
    ...was.map((old) => ({ kind: "slot", slot, op: "invalidate", value: old })),
  ];
}

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
      const text = typeof row.text === "string" ? row.text : undefined;
      const slots = text === undefined ? [] : extractSlots(text).flatMap(slotRecords);
      const rules = (text === undefined ? [] : extractRules(text)).map(
        ({ kind, class: cls, polarity, object, qualifier }) => ({
          kind,
          class: cls,
          polarity,
          object,
          ...(qualifier ? { qualifier } : {}),
        }),
      );
      const records = [...slots, ...rules];
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
