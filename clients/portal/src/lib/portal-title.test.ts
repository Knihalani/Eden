import { describe, expect, it } from "vitest";
import { portalDocumentTitle } from "@/lib/portal-title";

describe("portalDocumentTitle (R054)", () => {
  it("uses Page · Eden, never empty or the marketing tagline", () => {
    expect(portalDocumentTitle("/topics")).toBe("Topics · Eden");
    expect(portalDocumentTitle("/home")).toBe("Home · Eden");
    expect(portalDocumentTitle("/settings/pii")).toBe("PII policy · Eden");
    expect(portalDocumentTitle("")).toBe("Home · Eden");
    expect(portalDocumentTitle("/topics")).not.toMatch(/Observability \+ improvement/);
  });
});
