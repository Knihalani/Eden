# @kaiavn/sdk

```ts
import { Eden, runTool } from "@kaiavn/sdk";
```

From this clone: `import { runTool } from "../../packages/sdk-js/src/index.ts"`. This package is not on a public registry.

Point `EDEN_BASE_URL` (default `http://127.0.0.1:8788`) at wrap. `runTool` returns compiled facts when `/v1/wrap` answers `{action:"play"}` and otherwise runs your original, posting `/v1/ingest` without throwing. `@eden/know` is not a dependency — `Eden.know()` fail-opens to `{ unknown: true }` when Know is absent.
