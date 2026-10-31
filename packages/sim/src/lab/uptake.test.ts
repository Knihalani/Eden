import { describe, expect, test } from "bun:test";
import { packetLine, PACKETS_CHARS, UptakeLog, uptakeWay } from "./uptake";

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

  test("a firewall finding counts its ids with the packets' but places no packet", () => {
    const log = new UptakeLog();
    log.finding({ citations: cites("f") });
    log.packet({ text: "p1", citations: cites("a") });
    expect(log.packets).toEqual(["p1"]);
    expect(log.fields()).toEqual({ packets: "p1", cited: ["f", "a"], askCited: [] });
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
