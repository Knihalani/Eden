import { describe, expect, test } from "bun:test";
import { protocolCheck, protocolHeaders, EDEN_PROTOCOL_VERSION, PROTOCOL_HEADER } from "@eden/ir";

describe("protocol version gate", () => {
  test("constant is a positive integer and headers carry it", () => {
    expect(Number.isInteger(EDEN_PROTOCOL_VERSION)).toBe(true);
    expect(EDEN_PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(protocolHeaders()[PROTOCOL_HEADER]).toBe(String(EDEN_PROTOCOL_VERSION));
  });

  test("absent or malformed header is allowed (legacy clients keep working)", () => {
    expect(protocolCheck(null).ok).toBe(true);
    expect(protocolCheck(undefined).ok).toBe(true);
    expect(protocolCheck("").ok).toBe(true);
    expect(protocolCheck("banana").ok).toBe(true);
  });

  test("matching version allowed", () => {
    expect(protocolCheck(String(EDEN_PROTOCOL_VERSION)).ok).toBe(true);
  });

  test("mismatched version refused with 426 and actionable reason", () => {
    const gate = protocolCheck(String(EDEN_PROTOCOL_VERSION + 1));
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.status).toBe(426);
      expect(gate.reason).toContain(`client speaks ${EDEN_PROTOCOL_VERSION + 1}`);
      expect(gate.reason).toContain(`server speaks ${EDEN_PROTOCOL_VERSION}`);
    }
  });
});
