#!/usr/bin/env node
/**
 * CLI entry for `eden-doctor` / `npx @eden-ai/sdk`.
 * Thin wrapper so npm's bin validation gets a real shebang (tsup's
 * dist/doctor.js is an ESM re-export without one).
 */
import { main } from "../dist/doctor.js";

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
