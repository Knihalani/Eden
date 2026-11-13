import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { cardMessages } from "./cards";
import { checkMessages } from "./push-check";

// D1196, on by default since D1790 (`EDEN_MODEL_CACHE`): a provider caches only an identical prefix. The push
// check's and the card call's first message, the part a cache breakpoint covers, must not change with the user, the
// day, the request or the items.

const item = (id: string, text: string): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title: `Note ${id}`,
  text,
  updatedAt: Date.parse("2026-10-27T09:00:00Z"),
});

describe("the stable prefix a cache breakpoint covers", () => {
  test("the push check's system message is the same bytes for any request, day and pool", () => {
    const one = checkMessages({
      request: "Pay the Harlow deposit",
      today: "2026-10-27",
      items: [{ id: "a", hash: "1", source: "mail", title: "Hold", text: "On hold.", date: "2026-10-26", from: "" }],
    });
    const two = checkMessages({ request: "Book the lake house", today: "2026-11-02", items: [] });
    expect(one[0]!.role).toBe("system");
    expect(one[0]!.content).toBe(two[0]!.content);
    expect(one[1]!.content).not.toBe(two[1]!.content);
  });

  test("the card call's system message is the same bytes for any batch on one day, in each form", () => {
    for (const intent of [false, true])
      for (const form of [0, 3]) {
        const one = cardMessages([item("a", "Payments on hold until Friday.")], "2026-10-27", intent, form);
        const two = cardMessages([item("b", "Lunch with Ana."), item("c", "Gym at 7.")], "2026-10-27", intent, form);
        expect(one[0]!.role).toBe("system");
        expect(one[0]!.content).toBe(two[0]!.content);
        // It carries the user's day ("Today is …"): another day is another prefix. A provider's cache lives 5
        // minutes, so this splits nothing a cache would have shared, except between users in other time zones.
        const later = cardMessages([item("a", "Payments on hold until Friday.")], "2026-11-05", intent, form);
        expect(later[0]!.content).not.toBe(one[0]!.content);
      }
  });
});
