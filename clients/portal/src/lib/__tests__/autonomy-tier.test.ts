import { describe, expect, it } from "vitest";
import {
  autonomyTierChipLabel,
  autonomyTierShort,
} from "@/lib/autonomy-tier";

describe("autonomy-tier", () => {
  it("maps policy tier names to T0–T4 labels", () => {
    expect(autonomyTierShort("observe")).toBe("T0");
    expect(autonomyTierShort("auto_runtime_heal")).toBe("T2");
    expect(autonomyTierShort("auto_code_patch_pr")).toBe("T2");
    expect(autonomyTierShort("auto_prompt_canary")).toBe("T3");
    expect(autonomyTierShort("auto_code_patch_merge")).toBe("T4");
    expect(autonomyTierChipLabel("auto_code_patch_pr")).toBe("Autonomy T2");
    expect(autonomyTierShort("not_a_tier")).toBeNull();
  });
});
