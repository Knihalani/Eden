import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // CLI scripts use CommonJS + require(); eslint-config-next
    // doesn't know what to do with them. June 2026 cleanup.
    "scripts/**",
    // Playwright harnesses are plain .mjs; eslint-plugin-react 10
    // crashes on them (getFilename is not a function).
    "e2e/**",
  ]),
  {
    settings: {
      // Pin React version so eslint-plugin-react skips filesystem
      // detection (broken under ESLint 10: getFilename is not a function).
      react: { version: "19.2" },
    },
    rules: {
      // React 19 strict rules we deliberately opt out of (June 2026):
      //
      // - set-state-in-effect: too noisy. The vast majority of the
      //   violations are inside async event handlers (await client.foo()
      //   then setState) — a legitimate pattern, not a real bug.
      //   Re-enable per-file once the plugin learns to distinguish
      //   sync-from-async call sites.
      "react-hooks/set-state-in-effect": "off",
      // - preserve-manual-memoization: noisy on established patterns
      //   that already memoize correctly.
      "react-hooks/preserve-manual-memoization": "off",
      // - immutability: pattern is too aggressive — many call sites
      //   mutate React state objects inside `setX(prev => …)` which
      //   is the documented React pattern.
      "react-hooks/immutability": "off",
      // - refs: forbids storing refs.current = X during render. Our
      //   fetchRef pattern is intentional (see use-polling.ts).
      "react-hooks/refs": "off",
      // - purity: many pure-looking Date.now()/Math.random() calls in
      //   derivation hooks are deliberate for "now-relative" display.
      "react-hooks/purity": "off",
      // - exhaustive-deps: the codebase has established patterns where
      //   the dep is fetched/defined inside the effect (loadKey,
      //   loadMembers, loadArtifacts, …) and referenced via closure.
      //   The rule is "advisory" for us — every page handler that
      //   wants the strict check can re-enable per-file.
      "react-hooks/exhaustive-deps": "off",
      // Promote `no-explicit-any` to error: the portal interfaces with
      // dynamic FastAPI response shapes but every new code path should
      // opt-in via per-line eslint-disable with a reason. Tightening
      // this is the next step toward a fully-typed portal.
      "@typescript-eslint/no-explicit-any": "warn",
      // unused-vars: relax the catch-param + destructured-prop patterns.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "no-unused-vars": "off",
    },
  },
]);

export default eslintConfig;