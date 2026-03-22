import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import noTypeAssertion from "eslint-plugin-no-type-assertion";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/",
      "**/dist/",
      "coverage/",
      "**/coverage/",
      "node_modules/",
      "packages/flamecast/src/client/routeTree.gen.ts",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "no-type-assertion": noTypeAssertion,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-type-assertion/no-type-assertion": "error",
    },
  },
];
