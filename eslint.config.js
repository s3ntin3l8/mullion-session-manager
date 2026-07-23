import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },
  {
    // src/hooks/*.mjs and *.js (issues #174/#175) are plain JavaScript, not
    // TypeScript — see their own header comments for why (loaded directly
    // by an external agent's own hook runner/plugin loader, must run
    // unmodified under both tsx-watched dev and the compiled dist/ build,
    // with no tsc step of their own). TS files get Node globals (process,
    // setTimeout, ...) resolved through typescript-eslint's project
    // service; plain JS files under eslint's own `recommended` config don't
    // have any environment assumed, so `no-undef` flags every Node global
    // unless declared explicitly here.
    files: ["src/hooks/**/*.mjs", "src/hooks/**/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
      },
    },
  },
  {
    ignores: ["dist/", "node_modules/", "drizzle/", "coverage/", "frontend/"],
  },
);
