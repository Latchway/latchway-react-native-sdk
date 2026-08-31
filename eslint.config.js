import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".artifacts/**", "coverage/**", "example/android/**", "example/ios/**", "integration/**", "lib/**", "node_modules/**", "schema/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["Conformance/framework/**/*.ts", "example/src/**/*.{ts,tsx}", "src/**/*.ts", "test/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/restrict-template-expressions": ["error", { "allowNumber": true }]
    }
  },
  {
    files: ["Conformance/framework/**/*.ts", "test/**/*.ts"],
    rules: { "@typescript-eslint/require-await": "off" }
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-require-imports": "off",
      "no-console": "off"
    }
  }
);
