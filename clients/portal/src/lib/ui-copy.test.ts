import { describe, expect, it } from "vitest";
import {
  displayActor,
  formatPlanLabel,
  formatPlanMeta,
  isPhantomAbExperiment,
  isUuidLike,
  plural,
} from "@/lib/ui-copy";

describe("plural (R045)", () => {
  it("singularizes 1", () => {
    expect(plural(1, "key")).toBe("1 key");
    expect(plural(1, "member")).toBe("1 member");
  });
  it("pluralizes 0 and 2+", () => {
    expect(plural(0, "key")).toBe("0 keys");
    expect(plural(2, "member")).toBe("2 members");
  });
});

describe("displayActor (R047)", () => {
  it("maps the current user id to You", () => {
    expect(displayActor("user_abc123", "user_abc123")).toBe("You");
  });
  it("never prints a raw UUID", () => {
    expect(displayActor("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "A teammate",
    );
  });
  it("keeps human names", () => {
    expect(displayActor("Kaiav")).toBe("Kaiav");
  });
});

describe("formatPlanLabel (R067)", () => {
  it("falls back to Free when empty", () => {
    expect(formatPlanLabel("")).toBe("Free");
    expect(formatPlanLabel("  ")).toBe("Free");
    expect(formatPlanMeta("")).toBe("Free plan");
  });
  it("keeps a real tier", () => {
    expect(formatPlanLabel("Team")).toBe("Team");
    expect(formatPlanMeta("Team")).toBe("Team plan");
  });
});

describe("isUuidLike", () => {
  it("detects UUID and Clerk user ids", () => {
    expect(isUuidLike("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuidLike("user_2abcXYZ")).toBe(true);
    expect(isUuidLike("You")).toBe(false);
  });
});

describe("isPhantomAbExperiment (R052)", () => {
  it("hides zero-run generator seeds", () => {
    expect(
      isPhantomAbExperiment({
        name: "spec_generator_prompt_v2",
        arms: [{ nTraces: 0 }, { nTraces: 0 }],
      }),
    ).toBe(true);
  });
  it("keeps experiments with traffic", () => {
    expect(
      isPhantomAbExperiment({
        name: "spec_generator_prompt_v2",
        arms: [{ nTraces: 12 }, { nTraces: 10 }],
      }),
    ).toBe(false);
  });
});
