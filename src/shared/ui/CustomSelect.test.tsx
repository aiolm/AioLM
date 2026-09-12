import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { CustomSelect } from "./CustomSelect";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function renderSelect(onChange = vi.fn()) {
  render(<CustomSelect id="theme" value="light" options={OPTIONS} onChange={onChange} ariaLabel="Theme" />);
  const trigger = screen.getByRole("combobox", { name: "Theme" });
  if (!trigger) throw new Error("CustomSelect trigger button not found.");
  return { onChange, trigger };
}

describe("CustomSelect", () => {
  it("displays clean paths while selecting and submitting the original path", () => {
    const raw = String.raw`\\?\UNC\server\share\model.gguf`;
    const display = String.raw`\\server\share\model.gguf`;
    const onChange = vi.fn();
    const { container } = render(<form><CustomSelect name="model" value={raw} options={[{ value: raw, label: raw }]} onChange={onChange} ariaLabel="Model" /></form>);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent(display);
    expect(trigger.textContent).not.toContain("\\\\?\\");
    fireEvent.click(trigger);
    const option = screen.getByRole('option');
    expect(option.textContent).toBe(display);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(raw);
    expect(new FormData(container.querySelector('form')!).get('model')).toBe(raw);
  });

  it("keeps complete long labels in the trigger and options and serializes the value", () => {
    const label = "긴 프로필 이름 Japanese 中文 Long profile name ".repeat(12);
    const { container } = render(<form><CustomSelect name="profile" value="saved" options={[{ value: "saved", label }]} onChange={() => undefined} ariaLabel="Saved profile" /></form>);
    const trigger = screen.getByRole("combobox", { name: "Saved profile" });
    expect(trigger.textContent).toBe(label);
    expect(new FormData(container.querySelector("form")!).get("profile")).toBe("saved");
    fireEvent.click(trigger);
    expect(screen.getByRole("option").textContent).toBe(label);
  });
  it("links the trigger to the listbox and to the highlighted option", () => {
    const { trigger } = renderSelect();
    expect(trigger).not.toHaveAttribute("aria-activedescendant");
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Theme" });
    expect(trigger).toHaveAttribute("aria-controls", listbox.id);
    expect(trigger).toHaveAttribute("aria-activedescendant", `${listbox.id}-option-0`);
  });

  it("moves the highlight on arrow keys without committing a value", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("-option-1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits the highlighted option only on Enter", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("commits the highlighted option on Space", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: " " });
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the original value when Escape cancels an in-progress navigation", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("Light");
  });

  it("jumps the highlight to a typeahead match while open, without committing", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "s" });
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("-option-2"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects a typeahead match immediately while closed", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.keyDown(trigger, { key: "d" });
    expect(onChange).toHaveBeenCalledWith("dark");
  });

  it("has no axe-core accessibility violations, closed or open", async () => {
    const { trigger } = renderSelect();
    const closedResults = await axe.run(trigger.closest("div") ?? trigger);
    expect(closedResults.violations).toEqual([]);

    fireEvent.click(trigger);
    const openResults = await axe.run(trigger.closest("div") ?? trigger);
    expect(openResults.violations).toEqual([]);
  });
});
