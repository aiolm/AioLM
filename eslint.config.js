import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

const nativeDropdownRestriction = {
  selector: "JSXOpeningElement[name.name=/^(select|datalist)$/]",
  message: "Use the shared CustomSelect for dropdowns (its editable variant for free-text suggestions) instead of native <select> or <datalist>.",
};

export default [
  {
    ignores: ["dist/**", "packages/*/dist/**", "**/node_modules/**", "src-tauri/**", "*.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
  })),
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // Async test doubles deliberately retain the promise-returning API without awaiting.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": reactHooks },
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
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-control-regex": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: ["src/**/*.tsx"],
    settings: { "jsx-a11y": { components: { CustomSelect: "select", Switch: "button" } } },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Named scrolling regions retain keyboard access in older WebViews.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: [], roles: ["tabpanel", "region"], allowExpressionValues: true }],
      "jsx-a11y/label-has-associated-control": ["error", { depth: 5 }],
      // Safari drops list semantics when visual list markers are removed.
      "jsx-a11y/no-redundant-roles": ["error", { nav: ["navigation"], ol: ["list"], ul: ["list"], li: ["listitem"] }],
    },
  },
  {
    files: ["src/features/chat/MediaPreview.tsx"],
    rules: {
      // Local user media previews have no caption-track source.
      "jsx-a11y/media-has-caption": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly", console: "readonly", Buffer: "readonly", global: "readonly",
        URL: "readonly", URLSearchParams: "readonly", TextEncoder: "readonly", TextDecoder: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
        setImmediate: "readonly", clearImmediate: "readonly", queueMicrotask: "readonly",
        fetch: "readonly", Headers: "readonly", Request: "readonly", Response: "readonly",
        AbortController: "readonly", AbortSignal: "readonly", structuredClone: "readonly",
        atob: "readonly", btoa: "readonly", performance: "readonly",
      },
    },
    rules: {
      // Older scripts may keep explicit global comments alongside these defaults.
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
  {
    files: ["src/**/*.tsx"],
    ignores: ["**/*.test.tsx", "src/testing/**"],
    rules: {
      "no-restricted-syntax": ["error", nativeDropdownRestriction],
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
      "@typescript-eslint/no-explicit-any": "error",
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
      "no-restricted-syntax": ["error", nativeDropdownRestriction, {
        selector: "TSImportType[source.value=/(^|\\/)(app|features|testing)\\//i]",
        message: "Shared modules must stay independent of application composition, features, and test helpers.",
      }],
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
      "no-restricted-syntax": ["error", nativeDropdownRestriction, {
        selector: "TSImportType[source.value=/(^|\\/)(app|testing)\\//i]",
        message: "Features receive application callbacks through props and use shared contracts instead of importing the app shell.",
      }],
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/app/**", "**/testing/**"],
          message: "Features receive application callbacks through props and use shared contracts instead of importing the app shell.",
        }],
      }],
    },
  },
];
