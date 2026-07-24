import { describe, expect, it } from "vitest";
import {
  MARKETING_APP_HREF,
  MARKETING_APP_LABEL,
} from "@/lib/marketing-session";

describe("marketing-session", () => {
  it("routes signed-in visitors into the portal home", () => {
    expect(MARKETING_APP_HREF).toBe("/home");
    expect(MARKETING_APP_LABEL).toBe("Go to Eden");
  });
});
