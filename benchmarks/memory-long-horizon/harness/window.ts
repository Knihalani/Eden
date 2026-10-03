/**
 * The simulated context window (A5 §3.5): exactly what the model of one context window (the main thread or
 * a subagent) sees on the current branch. It holds every message, tool call, tool result and hook context
 * since the last compaction, plus the instruction files loaded into the window (A5 §2, `redundant_rate`).
 *
 * The session feeds it as it writes the transcript, so it follows the same branch: a rewind drops what came
 * after the rewound prompt (its packets too), compaction keeps only the summary and what follows it, a resumed
 * session keeps everything, and `/clear` starts a new window.
 */

/** A piece of text in the window, and the transcript line it came from. */
export interface Seen {
  uuid: string;
  text: string;
}

/** The window at one moment. Cheap to take: entries are shared, and the joined text is built on first use. */
export class WindowSnapshot {
  private joined?: string;

  constructor(
    readonly entries: readonly Seen[],
    /** The loaded instruction files, by path. */
    readonly instructions: ReadonlyMap<string, string>,
  ) {}

  /** Everything the model sees, instruction files first, one piece per line. */
  get text(): string {
    this.joined ??= [...this.instructions.values(), ...this.entries.map((entry) => entry.text)].join("\n");
    return this.joined;
  }
}

export class SimulatedWindow {
  private entries: Seen[] = [];
  /** How many entries the window held right after each line, so a rewind can return to it. */
  private readonly lengthAfter = new Map<string, number>();
  private readonly instructions = new Map<string, string>();

  /** A line the model sees. Lines with no text still mark a point a rewind can return to. */
  add(uuid: string, text: string): void {
    if (text) this.entries.push({ uuid, text });
    this.lengthAfter.set(uuid, this.entries.length);
  }

  /**
   * The branch now continues from the line `uuid` (null: from the start of the conversation): everything
   * added after it leaves the window. A line the window never saw is an error: the rewind would be lost.
   */
  rewindTo(uuid: string | null): void {
    const length = uuid === null ? 0 : this.lengthAfter.get(uuid);
    if (length === undefined) throw new Error(`the window never saw line ${uuid}`);
    this.entries = this.entries.slice(0, length);
  }

  /** Compaction: the conversation so far leaves the window; the summary is added next, like any line. */
  compact(): void {
    this.entries = [];
    this.lengthAfter.clear();
  }

  /** An instruction file loaded into this window (InstructionsLoaded); a reload replaces its text. */
  loadInstructions(path: string, text: string): void {
    this.instructions.set(path, text);
  }

  snapshot(): WindowSnapshot {
    return new WindowSnapshot(this.entries.slice(), new Map(this.instructions));
  }
}
