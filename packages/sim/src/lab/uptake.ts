/**
 * Delivery against uptake on hidden-context tasks (docs/research/econ-lab.md): what reached the agent in one task,
 * by which way, and the lines the lab tools write for it. Pure, so the recording and the report's split are tested
 * apart from the live harnesses that use them (`pi-ab.ts`, `pi-ab-report.ts`, `hidden-funnel.ts`). Sim worlds only.
 */

interface Cited {
  citations: readonly { itemId: string }[];
}

/** The longest a task line's joined packets get: enough to read a task's packets, not a run's worth per line. */
export const PACKETS_CHARS = 6_000;
/** The longest an agent's recorded `ask_context` question gets. */
export const QUESTION_CHARS = 500;
/** The longest a recorded `ask_context` answer's text gets: past the engine's 4,000-byte answer and its last lines. */
export const ANSWER_CHARS = 5_000;

/**
 * One `ask_context` call: the agent's question, the ids its answer cited, the answer's size in bytes and its text
 * (cut), whose "Eden's reader:" lines tell a reader-flagged item from one only listed.
 */
export interface AskRecord {
  question: string;
  cited: string[];
  bytes: number;
  text?: string;
}

/** One proactive packet's way: the kind of its reason (`reader`, `grounded`, `fallback`, …) and the ids it cited. */
export interface PacketWay {
  why: string;
  ids: string[];
}

/** One pi-ab task's packets, the item ids they cited, and the ids `ask_context` answers cited, in arrival order. */
export class UptakeLog {
  /** The packets' texts, oldest first: pi-ab also places these before the agent's next request. */
  readonly packets: string[] = [];
  private readonly cited: string[] = [];
  private readonly askCited: string[] = [];
  private readonly ways: PacketWay[] = [];

  /** A proactive packet that reached the agent; with its `reason`, the way it came is kept for attribution. */
  packet(i: Cited & { text: string; reason?: string }): void {
    this.packets.push(i.text);
    const ids = i.citations.map((c) => c.itemId);
    this.cited.push(...ids);
    if (i.reason !== undefined) this.ways.push({ why: i.reason.split(":")[0]!, ids });
  }

  /**
   * A firewall finding held an action call and was the tool's result (D69): it reached the agent unasked, so its ids
   * count with the packets', but it is no packet placed before a request.
   */
  finding(f: Cited): void {
    this.cited.push(...f.citations.map((c) => c.itemId));
  }

  /** An `ask_context` answer the agent read. */
  /**
   * An `ask_context` answer the agent read. With `question`, the agent's own question is kept with the answer's size
   * and cited ids, so a later run can replay the questions agents really ask (docs/research/gen-ask.md); sim worlds
   * only, whose data is fake.
   */
  answer(a: Cited & { answer?: string }, question?: string): void {
    const ids = a.citations.map((c) => c.itemId);
    this.askCited.push(...ids);
    if (question !== undefined) {
      this.asks.push({
        question: question.slice(0, QUESTION_CHARS),
        cited: ids,
        bytes: Buffer.byteLength(a.answer ?? ""),
        ...(a.answer ? { text: a.answer.slice(0, ANSWER_CHARS) } : {}),
      });
    }
  }

  private readonly asks: AskRecord[] = [];

  /**
   * The task line's fields: the joined packets (when any, cut), each way's cited ids, deduplicated, each packet's way
   * (when recorded with its reason), and the asks (when any were recorded with their question).
   */
  fields(): { packets?: string; ways?: PacketWay[]; cited: string[]; askCited: string[]; asks?: AskRecord[] } {
    return {
      ...(this.packets.length ? { packets: this.packets.join("\n").slice(0, PACKETS_CHARS) } : {}),
      ...(this.ways.length ? { ways: this.ways } : {}),
      cited: [...new Set(this.cited)],
      askCited: [...new Set(this.askCited)],
      ...(this.asks.length ? { asks: this.asks } : {}),
    };
  }
}

export type UptakeWay = "packet" | "ask" | "neither";

/**
 * How the planted item reached the agent: in a packet (whether or not an answer also cited it: the packet came
 * unasked), else only in an `ask_context` answer, else neither; null for a task with no planted item.
 */
export function uptakeWay(rec: {
  planted?: string;
  cited?: readonly string[];
  askCited?: readonly string[];
}): UptakeWay | null {
  if (!rec.planted) return null;
  if (rec.cited?.includes(rec.planted)) return "packet";
  return rec.askCited?.includes(rec.planted) ? "ask" : "neither";
}

/** One `hidden-funnel.ts --packets` line: a task, its planted item's id, and every packet Eden produced for it. */
export function packetLine(
  task: { suite: string; seed: number; variant: string; template: string; request: string; planted: string },
  injections: readonly (Cited & { reason: string; text: string })[],
) {
  return {
    ...task,
    packets: injections.map((x) => ({
      // The reason's kind (`grounded`, `judge`, …), not its detail.
      reason: x.reason.split(":")[0],
      text: x.text,
      ids: x.citations.map((c) => c.itemId),
    })),
  };
}
