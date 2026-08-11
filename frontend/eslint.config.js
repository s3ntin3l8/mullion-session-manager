import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import { sharedTypescriptRules } from "../eslint.shared.js";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat["recommended-latest"],
  reactRefresh.configs.vite,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: sharedTypescriptRules,
  },
  // Issue #95 — public/push-sw.js runs in a ServiceWorkerGlobalScope, not a
  // browser window: self/clients/registration aren't in globals.browser
  // above, and the shared block's TS-only rules (consistent-type-imports)
  // don't apply to a plain-JS file with no imports.
  {
    files: ["public/push-sw.js"],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
);
