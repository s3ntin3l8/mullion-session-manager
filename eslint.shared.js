// Shared between the root `eslint.config.js` and `frontend/eslint.config.js`
// (a separate npm workspace, imported via a relative `../eslint.shared.js`
// path). Both flat configs are plain JS (not TypeScript), so no `.js`-for-
// `.ts` extension juggling is needed here — this file already has the
// extension it's imported by.
export const sharedTypescriptRules = {
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
};
