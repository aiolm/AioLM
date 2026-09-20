import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "packages/*/dist/**", "**/node_modules/**", "src-tauri/**", "*.config.js", "scripts/build-cli.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: "readonly", document: "readonly", navigator: "readonly", localStorage: "readonly",
        fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly",
        clearInterval: "readonly", console: "readonly", performance: "readonly", crypto: "readonly",
        URL: "readonly", URLSearchParams: "readonly", AbortController: "readonly", AbortSignal: "readonly",
        TextDecoder: "readonly", TextEncoder: "readonly", ReadableStream: "readonly", Headers: "readonly",
        Request: "readonly", Response: "readonly", FormData: "readonly", Blob: "readonly",
        FileReader: "readonly", matchMedia: "readonly", requestAnimationFrame: "readonly",
      },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react/jsx-no-target-blank": "error",
      "react/prop-types": "off",
      "jsx-a11y/alt-text": "warn",
      "jsx-a11y/anchor-is-valid": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-control-regex": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.ts", "tests/direct/**/*.ts", "vite.config.ts"],
    languageOptions: {
      globals: {
        process: "readonly", console: "readonly", globalThis: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["packages/benchmark-contracts/**/*.{ts,mjs}"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", TextEncoder: "readonly", Buffer: "readonly" } },
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/src/shared/**", "**/app/**", "**/features/**", "@tauri-apps/*", "react"], message: "Benchmark contracts must build independently of the desktop application." }] }],
      "no-control-regex": "off",
    },
  },
  {
    files: ["src/shared/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/app/**", "**/features/**", "**/testing/**"],
          message: "Shared modules must stay independent of application composition, features, and test helpers.",
        }],
      }],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/app/**", "**/testing/**"],
          message: "Features receive application callbacks through props and use shared contracts instead of importing the app shell.",
        }],
      }],
    },
  },
];
