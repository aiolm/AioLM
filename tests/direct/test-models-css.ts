import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Refined design: Models.tsx now uses semantic app-button variants instead of
// hand-rolled Tailwind bg utilities. Verify the cascade regressions stay fixed
// under the new single-accent system.

const modelsTsx = readFileSync(new URL("../../src/features/models/Models.tsx", import.meta.url), "utf8");
const appPanelsCss = readFileSync(new URL("../../src/styles/app-panels.css", import.meta.url), "utf8");

// Rescan failure, retained records and retry are exercised in Models.css.test.tsx.
// The error action now belongs to FeedbackBanner; do not pin its markup here.

assert.ok(
  !modelsTsx.includes("hover:app-bg-accent-solid"),
  "Models.tsx should not use hover:app-bg-accent-solid — Tailwind never generates a rule for a variant of a custom class",
);
// New design uses app-button--primary (which already handles hover via CSS).
assert.ok(
  modelsTsx.includes("app-button--primary"),
  "Models.tsx should use app-button--primary for primary actions",
);

// Legacy app-hover class is no longer required; ensure the panels CSS still
// provides a consistent hover token via the component system rather than a
// per-element utility.
assert.ok(
  !appPanelsCss.includes("hover:app-bg-accent-solid"),
  "app-panels.css should not contain literal hover:app-* strings",
);

// Theme contrast, control reachability and overflow are verified in the
// rendered viewport matrix; do not freeze the old palette or pixel values here.

// The outer page owns vertical scrolling. The stacked project grid must keep
// its intrinsic height so the saved-project list cannot collapse on narrow windows.
const projectsTsx = readFileSync(new URL("../../src/features/projects/Projects.tsx", import.meta.url), "utf8");
assert.match(projectsTsx, /className="[^"]*\bgrid\b[^"]*\bshrink-0\b[^"]*"/);
assert.doesNotMatch(projectsTsx, /<aside className="min-h-0/);

const viteConfig = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
assert.ok(viteConfig.includes('"**/.codex-target/**"'), "runtime builds must not trigger dev reloads");
assert.ok(viteConfig.includes('"**/coverage/**"'), "coverage reports must not trigger dev reloads");

console.log("Models.tsx, Projects.tsx and shared CSS cascade regressions passed");
