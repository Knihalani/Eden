/**
 * Built-in tools for the smoke agent.
 * Keep these deterministic so prod Eden traces are easy to inspect.
 */

export type ToolName =
  | "get_current_time"
  | "calculate"
  | "lookup_city"
  | "echo_json";

export interface ToolDefinition {
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Return the current UTC ISO timestamp and unix epoch seconds.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Evaluate a simple arithmetic expression. Supports +, -, *, /, parentheses, and decimals.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Arithmetic expression, e.g. '(12.5 + 7) * 2'",
          },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_city",
      description:
        "Look up a known city from a tiny built-in directory (for tool-call smoke tests).",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "City name, e.g. 'Singapore' or 'San Francisco'",
          },
        },
        required: ["city"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "echo_json",
      description: "Echo structured JSON back — useful for verifying tool payloads in Eden traces.",
      parameters: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            description: "Any JSON object to echo.",
          },
        },
        required: ["payload"],
        additionalProperties: false,
      },
    },
  },
];

const CITY_DIRECTORY: Record<
  string,
  { country: string; timezone: string; note: string }
> = {
  singapore: {
    country: "Singapore",
    timezone: "Asia/Singapore",
    note: "UTC+8 year-round",
  },
  "san francisco": {
    country: "United States",
    timezone: "America/Los_Angeles",
    note: "Pacific Time",
  },
  london: {
    country: "United Kingdom",
    timezone: "Europe/London",
    note: "GMT / BST",
  },
  tokyo: {
    country: "Japan",
    timezone: "Asia/Tokyo",
    note: "UTC+9 year-round",
  },
  berlin: {
    country: "Germany",
    timezone: "Europe/Berlin",
    note: "CET / CEST",
  },
};

function safeCalculate(expression: string): number {
  const cleaned = expression.replace(/\s+/g, "");
  if (!/^[\d.+\-*/()]+$/.test(cleaned)) {
    throw new Error("Expression contains unsupported characters");
  }
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${cleaned});`)();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expression did not evaluate to a finite number");
  }
  return value;
}

export async function executeTool(
  name: string,
  rawArgs: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};

    switch (name as ToolName) {
      case "get_current_time": {
        const now = new Date();
        return {
          ok: true,
          result: {
            iso_utc: now.toISOString(),
            unix_seconds: Math.floor(now.getTime() / 1000),
          },
        };
      }
      case "calculate": {
        const expression = String(args.expression ?? "");
        const value = safeCalculate(expression);
        return { ok: true, result: { expression, value } };
      }
      case "lookup_city": {
        const city = String(args.city ?? "").trim().toLowerCase();
        const hit = CITY_DIRECTORY[city];
        if (!hit) {
          return {
            ok: true,
            result: {
              found: false,
              city: args.city,
              available: Object.keys(CITY_DIRECTORY),
            },
          };
        }
        return {
          ok: true,
          result: { found: true, city: args.city, ...hit },
        };
      }
      case "echo_json": {
        return { ok: true, result: { echoed: args.payload ?? args } };
      }
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
