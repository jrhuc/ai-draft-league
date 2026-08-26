import { defineConfig } from "vite-plus";

// Repo-wide lint home: typeAware options are only honored in the root config.
export default defineConfig({
  lint: {
    ignorePatterns: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "tools/oxlint/anti-slop/**",
      "packages/league/dist/**",
      "packages/league/pokemon-showdown/**",
      "packages/league/runs/**",
      "packages/league/records/**",
      "packages/league/boards/**",
      "packages/league/docs/**",
    ],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    rules: {
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
    options: { typeAware: true, typeCheck: true },
    overrides: [
      {
        // Test assertion idioms only; src and tools pass every rule outright.
        files: ["packages/league/tests/**"],
        rules: {
          "typescript/no-floating-promises": "off",
          "typescript/no-base-to-string": "off",
          "typescript/restrict-template-expressions": "off",
          "typescript/require-array-sort-compare": "off",
        },
      },
    ],
  },
  test: {
    projects: ["apps/site"],
  },
});
