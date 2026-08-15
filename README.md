# Eden

The agent still talks and still decides. Eden sits on the **tool path**.

1. Record tool calls (cheap, local).
2. After a human approves on the site, host one compiled tool on our MCP.
3. Steer if the agent starts the old stretch anyway.

Approve only on the website. `eden open` is the browser. A key never turns a tool On.

- Site + MCP: https://eden-murex-nine.vercel.app
- Local: `bun run --cwd apps/site dev` then `bun run packages/cli/src/cli.ts setup`

```
Dashboard  /dashboard
Workshop   /workshop
MCP        POST /mcp
```
