import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom has no layout engine, so these pin the declarations that keep a long
// failure diagnostic (unbroken paths, compiler output) from widening the task
// strip past a 360px window. The overflow itself, and the fix, were measured
// in a real browser at 360x520 (device scale 2) with the real stylesheets and
// components: before, the strip scrolled sideways (316px view, 644px content)
// and Cancel/Dismiss sat outside it; after, nothing overflows at 360, 640 or
// 1280px and the wide layout is unchanged.
const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const shell = css("../../styles/app-shell.css");
const responsive = css("../../styles/app-responsive.css");
const diagnostic = css("./DiagnosticDetails.css");

/** Declarations of every innermost rule whose selector list names `selector`. */
function declarations(source: string, selector: string): string {
  const rules = [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  return rules.filter(rule => rule[1].split(",").some(part => part.trim() === selector)).map(rule => rule[2]).join(";");
}

function narrow(source: string): string {
  const start = source.indexOf("@media (max-width: 639px) {");
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(source.indexOf("{", start) + 1, index);
  }
  throw new Error("unterminated narrow media block");
}

describe("task strip at the supported minimum window", () => {
  it("lets task rows and their copy shrink below long unbroken diagnostic tokens", () => {
    expect(declarations(shell, ".app-task-strip__item")).toMatch(/min-width:\s*0/);
    expect(declarations(shell, ".app-task-strip__copy")).toMatch(/min-width:\s*0/);
    expect(declarations(shell, ".app-task-strip__list")).toMatch(/min-width:\s*0/);
  });

  it("wraps long labels, short details and the diagnostic summary anywhere instead of setting the row width", () => {
    // `break-word` does not lower the min-content width; `anywhere` does.
    for (const selector of [".app-task-strip__label", ".app-task-strip__detail"]) {
      expect(declarations(shell, selector)).toMatch(/overflow-wrap:\s*anywhere/);
    }
    expect(declarations(diagnostic, ".app-diagnostic-summary")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(declarations(diagnostic, ".app-diagnostic-full")).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the full diagnostic scrollable and the strip itself scrollable rather than clipped", () => {
    expect(declarations(diagnostic, ".app-diagnostic-full")).toMatch(/overflow:\s*auto/);
    expect(declarations(shell, ".app-task-strip")).toMatch(/overflow:\s*auto/);
  });

  it("gives the copy the whole row on narrow windows with progress and buttons below it", () => {
    const block = narrow(responsive);
    expect(declarations(block, ".app-task-strip__item")).toMatch(/flex-wrap:\s*wrap/);
    expect(declarations(block, ".app-task-strip__copy")).toMatch(/flex:\s*1 1 100%/);
  });
});
