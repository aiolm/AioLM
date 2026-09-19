import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ChatMarkdown from "./ChatMarkdown";
import { parseInline, parseMarkdown } from "./markdown";

function mount(source: string) {
  const { container } = render(<ChatMarkdown source={source} />);
  return container.querySelector(".chat-markdown")!;
}

describe("assistant markdown", () => {
  it("renders a fenced block as code rather than as its backticks", () => {
    const root = mount("Intro\n\n```text\nC = truth teller\nA = liar\n```\n\nAfter");
    const code = root.querySelector("pre > code")!;
    expect(code.textContent).toBe("C = truth teller\nA = liar");
    expect(root.querySelector("pre")).toHaveAttribute("data-language", "text");
    expect(root.textContent).not.toContain("```");
    expect(root.querySelectorAll("p")).toHaveLength(2);
  });

  it("keeps a fence the model has not closed yet as the code block it is writing", () => {
    // Half of every streamed answer is in this state; falling back to literal
    // text would make the block flicker into place when the closer arrives.
    const root = mount("Here:\n\n```py\nprint(1)");
    expect(root.querySelector("pre > code")!.textContent).toBe("print(1)");
  });

  it("marks up emphasis, strikethrough and inline code", () => {
    const root = mount("**C is the truth teller**, *maybe* ~~not~~ `--lazy-mode on`");
    expect(within(root as HTMLElement).getByText("C is the truth teller").tagName).toBe("STRONG");
    expect(within(root as HTMLElement).getByText("maybe").tagName).toBe("EM");
    expect(within(root as HTMLElement).getByText("not").tagName).toBe("DEL");
    expect(within(root as HTMLElement).getByText("--lazy-mode on").tagName).toBe("CODE");
  });

  it("leaves an unmatched marker as the character the model wrote", () => {
    const root = mount("2 * 3 = 6 and a_variable_name stays whole");
    expect(root.querySelector("em")).toBeNull();
    expect(root.textContent).toContain("2 * 3 = 6");
  });

  it("renders headings below the page's own, so an answer cannot outrank the panel", () => {
    const root = mount("# Result\n\n## Detail");
    expect(root.querySelector("h1")).toBeNull();
    expect(root.querySelector("h3")!.textContent).toBe("Result");
    expect(root.querySelector("h4")!.textContent).toBe("Detail");
  });

  it("builds ordered, unordered and nested lists", () => {
    const root = mount("- first\n- second\n  - nested\n\n1. one\n2. two");
    const unordered = root.querySelector("ul")!;
    expect(unordered.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(unordered.querySelector("li > ul > li")!.textContent).toBe("nested");
    const ordered = root.querySelector("ol")!;
    expect(ordered).toHaveAttribute("start", "1");
    expect(ordered.querySelectorAll("li")).toHaveLength(2);
  });

  it("numbers an ordered list from where the model started it", () => {
    expect(mount("3. third\n4. fourth").querySelector("ol")).toHaveAttribute("start", "3");
  });

  it("builds a table with its column alignment", () => {
    const root = mount("| Backend | Median KLD |\n| :--- | ---: |\n| ROCm | 0.67 |\n| Vulkan | 0.0019 |");
    expect(root.querySelectorAll("th")).toHaveLength(2);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelectorAll("th")[1]).toHaveStyle({ textAlign: "right" });
  });

  it("renders quotes and rules", () => {
    const root = mount("> quoted line\n\n---");
    expect(root.querySelector("blockquote")!.textContent).toBe("quoted line");
    expect(root.querySelector("hr")).toBeInTheDocument();
  });

  it("links only schemes this app would follow", () => {
    const root = mount("[docs](https://example.test/a) and [bad](javascript:alert(1))");
    const link = within(root as HTMLElement).getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.test/a");
    expect(link).toHaveAttribute("rel", "noreferrer");
    // The refused one keeps its literal text rather than becoming a dead link.
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("produces no html for a model to inject", () => {
    const root = mount("<img src=x onerror=alert(1)> and <b>bold</b>");
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("honours backslash escapes so literal markers survive", () => {
    expect(parseInline(String.raw`\*not emphasis\*`)).toEqual([{ kind: "text", value: "*not emphasis*" }]);
  });

  it("keeps soft line breaks inside a paragraph", () => {
    const [block] = parseMarkdown("line one\nline two");
    expect(block).toEqual({ kind: "paragraph", children: [{ kind: "text", value: "line one\nline two" }] });
  });

  it("returns nothing for empty output instead of an empty paragraph", () => {
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});
