import { describe, expect, test } from "bun:test";
import { ANSWER_CHARS, packetLine, PACKETS_CHARS, QUESTION_CHARS, UptakeLog, uptakeWay } from "./uptake";

const cites = (...ids: string[]) => ids.map((itemId) => ({ itemId }));

describe("uptake recording", () => {
  test("a task's packets and answers are recorded with the ids each way cited, deduplicated", () => {
    const log = new UptakeLog();
    log.packet({ text: "p1", citations: cites("a", "b") });
    log.answer({ citations: cites("c") });
    log.packet({ text: "p2", citations: cites("b", "d") });
    log.answer({ citations: cites("c", "a") });
    expect(log.packets).toEqual(["p1", "p2"]);
    expect(log.fields()).toEqual({ packets: "p1\np2", cited: ["a", "b", "d"], askCited: ["c", "a"] });
  });

  test("an ask recorded with its question keeps the question, its cited ids and the answer's bytes", () => {
    const log = new UptakeLog();
    log.answer({ citations: cites("c"), answer: "héllo" }, "Is Sam around on Friday?");
    log.answer({ citations: cites("a") });
    log.answer({ citations: [], answer: "" }, "q".repeat(QUESTION_CHARS + 10));
    const f = log.fields();
    expect(f.askCited).toEqual(["c", "a"]);
    expect(f.asks).toEqual([
      { question: "Is Sam around on Friday?", cited: ["c"], bytes: 6, text: "héllo" },
      { question: "q".repeat(QUESTION_CHARS), cited: [], bytes: 0 },
    ]);
  });

  test("a packet recorded with its reason keeps its way (the reason's kind) and ids; a long answer text is cut", () => {
    const log = new UptakeLog();
    log.packet({ text: "p1", citations: cites("a"), reason: "reader:c12" });
    log.packet({ text: "p2", citations: cites("b", "c"), reason: "grounded-conflict:c13" });
    log.answer({ citations: cites("d"), answer: "y".repeat(ANSWER_CHARS + 5) }, "q");
    const f = log.fields();
    expect(f.ways).toEqual([
      { why: "reader", ids: ["a"] },
      { why: "grounded-conflict", ids: ["b", "c"] },
    ]);
    expect(f.asks?.[0]?.text).toHaveLength(ANSWER_CHARS);
  });

  test("a task with no packet records none, and long packets are cut", () => {
    expect(new UptakeLog().fields()).toEqual({ cited: [], askCited: [] });
    const log = new UptakeLog();
    log.packet({ text: "x".repeat(PACKETS_CHARS + 50), citations: [] });
    expect(log.fields().packets).toHaveLength(PACKETS_CHARS);
  });

  test("the planted item reached the agent in a packet before an answer, else in an answer, else neither", () => {
    expect(uptakeWay({ planted: "p", cited: ["p"], askCited: ["p"] })).toBe("packet");
    expect(uptakeWay({ planted: "p", cited: ["x"], askCited: ["p"] })).toBe("ask");
    expect(uptakeWay({ planted: "p", cited: ["x"], askCited: [] })).toBe("neither");
    // A line from a condition without Eden has no cited ids at all.
    expect(uptakeWay({ planted: "p" })).toBe("neither");
    expect(uptakeWay({ cited: ["p"] })).toBeNull();
  });

  test("the funnel's packet line carries the task, the planted id and each packet's reason kind, text and ids", () => {
    const task = { suite: "heldout", seed: 41, variant: "hidden", template: "t", request: "r", planted: "p" };
    const line = packetLine(task, [
      { reason: "grounded: name and date", text: "T1", citations: cites("p", "q") },
      { reason: "judge", text: "T2", citations: [] },
    ]);
    expect(line).toEqual({
      ...task,
      packets: [
        { reason: "grounded", text: "T1", ids: ["p", "q"] },
        { reason: "judge", text: "T2", ids: [] },
      ],
    });
  });
});
