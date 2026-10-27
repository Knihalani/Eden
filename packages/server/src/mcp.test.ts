import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StaticSource } from "@eden/sources";
import { buildPartner } from "./build";
import { createMcpServer } from "./mcp";

test("an MCP agent can ask the partner through ask_context", async () => {
  const cal = new StaticSource("calendar", "events", [{ ref: "e1", title: "Dentist", text: "Dentist Friday 9am" }]);
  const partner = buildPartner({ sources: async () => [cal], model: null });
  const server = createMcpServer(partner, { tenantId: "t", userId: "u", sessionId: "s" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(["ask_context"]);
  const res = (await client.callTool({ name: "ask_context", arguments: { question: "when is the dentist?" } })) as {
    content: { text: string }[];
  };
  expect(res.content[0]!.text).toContain("Dentist Friday 9am");
  await client.close();
});
