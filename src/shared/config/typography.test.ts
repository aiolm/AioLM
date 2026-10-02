import { afterEach, describe, expect, it } from "vitest";
import { applyTypography } from "./typography";

const root = document.documentElement;
const props = ["--font-sans", "--font-mono", "--font-chat-code", "--chat-prose-leading", "--chat-reasoning-leading"];
const apply = (fontFamily: "default" | "system" | "serif", codeFontFamily: "default" | "system", lineSpacing: "compact" | "normal" | "relaxed") =>
  applyTypography(root, { appearance: { fontFamily, codeFontFamily }, chat: { lineSpacing } });

describe("applyTypography", () => {
  afterEach(() => root.removeAttribute("style"));

  it("leaves the stylesheet typography untouched for the defaults", () => {
    apply("default", "default", "normal");
    for (const name of props) expect(root.style.getPropertyValue(name)).toBe("");
  });

  it("overrides the font tokens and chat leading for other choices", () => {
    apply("serif", "system", "relaxed");
    expect(root.style.getPropertyValue("--font-sans")).toMatch(/serif$/);
    expect(root.style.getPropertyValue("--font-mono")).toMatch(/monospace$/);
    // Chat code reads its own token, so the code choice must reach it too.
    expect(root.style.getPropertyValue("--font-chat-code")).toBe(root.style.getPropertyValue("--font-mono"));
    expect(root.style.getPropertyValue("--chat-prose-leading")).toBe("1.9");
    expect(root.style.getPropertyValue("--chat-reasoning-leading")).toBe("1.8");

    apply("system", "system", "compact");
    expect(root.style.getPropertyValue("--font-sans")).toMatch(/^system-ui,.*sans-serif$/);
    expect(root.style.getPropertyValue("--chat-prose-leading")).toBe("1.5");
  });

  it("removes every override when returning to the defaults", () => {
    apply("serif", "system", "compact");
    apply("default", "default", "normal");
    for (const name of props) expect(root.style.getPropertyValue(name)).toBe("");
  });
});
