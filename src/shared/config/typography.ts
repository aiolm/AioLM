import type { AppFontFamily, AppPreferences, ChatLineSpacing, CodeFontFamily } from "./preferences";

/*
 * Font and line-spacing choices are applied as CSS custom properties on the
 * document root, so changing them restyles the open workspace in place: no
 * panel remounts and chat drafts stay where they are.
 *
 * "default" removes the override and leaves the stylesheet values untouched
 * (bundled Pretendard for interface text, Cascadia Code for code in the app
 * chrome and the existing monospace stack in chat answers). The other choices
 * are fixed, portable stacks that resolve to fonts the operating system
 * already ships; installed fonts are never enumerated or downloaded. CJK text
 * falls through to the generic family, which follows the document language.
 */
const appFontStacks: Record<Exclude<AppFontFamily, "default">, string> = {
  system: 'system-ui, -apple-system, "Segoe UI", "Noto Sans", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", "Times New Roman", serif',
};
const codeFontStacks: Record<Exclude<CodeFontFamily, "default">, string> = {
  system: 'ui-monospace, "Cascadia Mono", "Segoe UI Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
};

/** Unitless line heights; "normal" matches the values the chat stylesheet already uses. */
export const chatLineHeights: Record<ChatLineSpacing, { prose: number; reasoning: number }> = {
  compact: { prose: 1.5, reasoning: 1.45 },
  normal: { prose: 1.7, reasoning: 1.625 },
  relaxed: { prose: 1.9, reasoning: 1.8 },
};

/** The font-family value for interface text; "default" reads the stylesheet token. */
export function appFontFamilyValue(choice: AppFontFamily): string {
  return choice === "default" ? "var(--font-sans)" : appFontStacks[choice];
}

/** The font-family value for chat code; "default" reads the stylesheet token. */
export function codeFontFamilyValue(choice: CodeFontFamily): string {
  return choice === "default" ? "var(--font-chat-code)" : codeFontStacks[choice];
}

type TypographyPreferences = { appearance: Pick<AppPreferences["appearance"], "fontFamily" | "codeFontFamily">; chat: Pick<AppPreferences["chat"], "lineSpacing"> };

export function applyTypography(root: HTMLElement, preferences: TypographyPreferences): void {
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };
  const { fontFamily, codeFontFamily } = preferences.appearance;
  const { lineSpacing } = preferences.chat;
  set("--font-sans", fontFamily === "default" ? undefined : appFontStacks[fontFamily]);
  const code = codeFontFamily === "default" ? undefined : codeFontStacks[codeFontFamily];
  set("--font-mono", code);
  set("--font-chat-code", code);
  const leading = lineSpacing === "normal" ? undefined : chatLineHeights[lineSpacing];
  set("--chat-prose-leading", leading && String(leading.prose));
  set("--chat-reasoning-leading", leading && String(leading.reasoning));
}
