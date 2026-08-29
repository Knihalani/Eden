import { describe, expect, test } from "bun:test";
import {
  protocolCheck,
  protocolHeaders,
  protocolSkewHeader,
  EDEN_PROTOCOL_VERSION,
  PROTOCOL_HEADER,
  PROTOCOL_SKEW_HEADER,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  negotiateMcpProtocolVersion,
  readMcpProtocolVersion,
  mcpUnsupportedVersionError,
} from "@eden/ir";

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

  test("unknown future stays 426 — skew header does not relax it", () => {
    const future = String(EDEN_PROTOCOL_VERSION + 99);
    const gate = protocolCheck(future);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.status).toBe(426);
    expect(protocolSkewHeader(future)).toBeUndefined();
    expect(protocolSkewHeader(String(EDEN_PROTOCOL_VERSION))).toBeUndefined();
    expect(protocolSkewHeader("banana")).toBeUndefined();
    expect(protocolSkewHeader(null)).toBeUndefined();
    expect(PROTOCOL_SKEW_HEADER).toBe("x-eden-protocol-skew");
    // Known-older integers (1 ≤ n < current) would warn; with current === 1 the set is empty.
    if (EDEN_PROTOCOL_VERSION > 1) {
      expect(protocolSkewHeader("1")).toContain("client=1");
      expect(protocolCheck("1").ok).toBe(false);
    }
  });
});

describe("MCP protocol version negotiation", () => {
  test("supported set includes 2024-11-05 and 2025-03-26; latest is 2025-03-26", () => {
    expect(MCP_PROTOCOL_VERSIONS).toContain("2024-11-05");
    expect(MCP_PROTOCOL_VERSIONS).toContain("2025-03-26");
    expect(MCP_LATEST_PROTOCOL_VERSION).toBe("2025-03-26");
  });

  test("echoes a supported proposal", () => {
    expect(negotiateMcpProtocolVersion("2025-03-26")).toEqual({ protocolVersion: "2025-03-26", echoed: true });
    expect(negotiateMcpProtocolVersion("2024-11-05")).toEqual({ protocolVersion: "2024-11-05", echoed: true });
  });

  test("missing / non-string / garbage / 1.0.0 degrade to server latest — never throw", () => {
    const degrade = (v: unknown) => {
      const r = negotiateMcpProtocolVersion(v);
      expect(r.echoed).toBe(false);
      expect(r.protocolVersion).toBe("2025-03-26");
    };
    degrade(undefined);
    degrade(null);
    degrade("1.0.0");
    degrade("garbage");
    degrade(2025);
    degrade({ not: "a string" });
    degrade(["2025-03-26"]);
    degrade("x".repeat(200_000));
    const hostile = {
      get protocolVersion() {
        throw new Error("boom");
      },
    };
    expect(readMcpProtocolVersion(hostile)).toBeUndefined();
    expect(negotiateMcpProtocolVersion(readMcpProtocolVersion(hostile)).protocolVersion).toBe("2025-03-26");
  });

  test("structured JSON-RPC error names supported + requested without exploding on huge input", () => {
    const err = mcpUnsupportedVersionError("1.0.0");
    expect(err.code).toBe(-32602);
    expect(err.data.supported).toEqual(["2024-11-05", "2025-03-26"]);
    expect(err.data.requested).toBe("1.0.0");
    const huge = mcpUnsupportedVersionError("z".repeat(50_000));
    expect(String(huge.data.requested).length).toBeLessThan(80);
    const obj = mcpUnsupportedVersionError({ not: "a string" });
    expect(obj.data.requested).toEqual({ type: "object" });
    expect(mcpUnsupportedVersionError(2025).data.requested).toBe(2025);
  });
});
