# Publishing `@eden-ai/sdk` to npm

These are the exact commands to publish the TypeScript SDK to npm as `@eden-ai/sdk`.

## Prerequisites

```bash
# 1. Make sure you have an npm account and a publish token:
#    https://www.npmjs.com/settings/~/tokens
# 2. Login to npm:
npm login
#    (or) use a token in CI:
#    export NPM_TOKEN=npm_xxxxxxxxxxxx
#    echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
```

## Pre-flight

```bash
cd sdk/ts-ai

# 1. Clean previous build artifacts:
rm -rf dist

# 2. TypeScript must compile cleanly:
bun run typecheck
# → tsc --noEmit (no output means OK)

# 3. Full test suite must pass (74 tests):
bun test
# → "74 pass, 0 fail"

# 4. Verify the build script produces all the deep-export subpaths:
#    The package.json declares exports for:
#      ./instrumentations/openai, ./instrumentations/anthropic,
#      ./instrumentations/vercel-ai, ./instrumentations/langchain
#    Each one must end up at dist/instrumentations/*.js + .d.ts.
grep '"build"' package.json
# → "tsup src/index.ts src/instrumentations/openai.ts \
#    src/instrumentations/anthropic.ts src/instrumentations/vercel-ai.ts \
#    src/instrumentations/langchain.ts --format esm,cjs --dts --clean"
```

## Build

```bash
cd sdk/ts-ai
npm run build
# → ESM dist/index.js
# → CJS dist/index.cjs
# → DTS dist/index.d.ts + dist/index.d.cts
# → ESM dist/instrumentations/{openai,anthropic,vercel-ai,langchain}.js
# → DTS dist/instrumentations/{openai,anthropic,vercel-ai,langchain}.{d.ts,d.cts}
```

## Validate

```bash
# 1. Inspect the npm tarball to confirm files match the `exports` map:
npm pack --dry-run --cache /tmp/npm-cache
# → Tarball Details: 30 files, 51.7 kB packed / 254.2 kB unpacked

# 2. Smoke-test the installable artifact in a scratch project:
mkdir -p /tmp/eden-sdk-verify
mkdir -p /tmp/eden-sdk-verify/node_modules/@eden-ai
ln -sf "$(pwd)" /tmp/eden-sdk-verify/node_modules/@eden-ai/sdk

cat > /tmp/eden-sdk-verify/test.mjs << 'JS'
import { EdenSDK, wrapOpenAI } from "@eden-ai/sdk";
import { wrapAnthropic } from "@eden-ai/sdk/instrumentations/anthropic";
import { wrapVercelAI } from "@eden-ai/sdk/instrumentations/vercel-ai";
import { wrapLangChain } from "@eden-ai/sdk/instrumentations/langchain";

console.log("EdenSDK:", typeof EdenSDK);
console.log("wrapOpenAI:", typeof wrapOpenAI);
console.log("wrapAnthropic:", typeof wrapAnthropic);
console.log("wrapVercelAI:", typeof wrapVercelAI);
console.log("wrapLangChain:", typeof wrapLangChain);
JS

cat > /tmp/eden-sdk-verify/test.cjs << 'JS'
const { EdenSDK } = require("@eden-ai/sdk");
console.log("CJS EdenSDK:", typeof EdenSDK);
JS

cd /tmp/eden-sdk-verify && node test.mjs && node test.cjs
# → "EdenSDK: function"
# → "wrapOpenAI: function"
# → "wrapAnthropic: function"
# → "wrapVercelAI: function"
# → "wrapLangChain: function"
# → "CJS EdenSDK: function"

# Clean up:
rm -rf /tmp/eden-sdk-verify
```

## Dry-run publish (optional but recommended)

```bash
npm publish --dry-run --cache /tmp/npm-cache
# → Shows what files would be uploaded. No actual publish happens.
# → The "files" array in package.json controls what gets included:
#     ["dist", "README.md"]
```

## Publish

### First-time publish

```bash
cd sdk/ts-ai
npm publish --access public
# → "@eden-ai/sdk@0.1.0" → https://www.npmjs.com/package/@eden-ai/sdk
# Note: scoped packages (those starting with `@`) default to private.
#       The `--access public` flag is required for the first publish.
```

### Verify

```bash
# In a fresh project:
mkdir /tmp/eden-verify && cd /tmp/eden-verify
npm init -y
npm install @eden-ai/sdk
node -e "import('@eden-ai/sdk').then(m => console.log('OK', typeof m.EdenSDK))"
```

## Tag the release

```bash
cd /Users/kaiavnihalani/Downloads/Eden
git tag -a sdk-ts-v0.1.0 -m "Release @eden-ai/sdk 0.1.0"
git push origin sdk-ts-v0.1.0
```

## Publishing a new version

1. Bump `version` in `sdk/ts-ai/package.json` (`"0.1.0"` → `"0.1.1"`).
2. Re-run the pre-flight and build steps above.
3. `git tag -a sdk-ts-v0.1.1 -m "Release @eden-ai/sdk 0.1.1" && git push origin sdk-ts-v0.1.1`.
