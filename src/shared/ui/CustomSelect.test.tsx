import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { useState } from 'react';
import { CustomSelect, OverlayContainerContext } from "./CustomSelect";

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
  it('keeps editable values outside the suggestions and uses the common listbox for choices', () => {
    const onChange = vi.fn();
    function Editable() {
      const [value, setValue] = useState('custom value');
      return <CustomSelect ariaLabel="Runtime value" value={value} options={OPTIONS}
        onInputChange={setValue} onChange={next => { setValue(next); onChange(next); }} />;
    }
    render(<Editable />);
    const input = screen.getByRole('combobox', { name: 'Runtime value' });
    expect(input).toHaveValue('custom value');
    fireEvent.change(input, { target: { value: 'da' } });
    expect(input).toHaveValue('da');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('dark');
    expect(onChange).toHaveBeenCalledWith('dark');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(input, { target: { value: 'a value beyond the list' } });
    expect(input).toHaveValue('a value beyond the list');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('leaves spaces, Home, End and composition keys available to editable inputs', () => {
    const onChange = vi.fn();
    render(<CustomSelect value="light" options={OPTIONS} onChange={onChange} onInputChange={vi.fn()} ariaLabel="Runtime value" />);
    const input = screen.getByRole('combobox');
    fireEvent.click(input);
    for (const key of [' ', 'Home', 'End']) expect(fireEvent.keyDown(input, { key })).toBe(true);
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('light');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('displays a normalized suggested path but commits its original value', () => {
    const raw = String.raw`\\?\C:\synthetic\models\draft.gguf`;
    const onChange = vi.fn();
    render(<CustomSelect value="" options={[{ value: raw, label: raw }]} onChange={onChange} onInputChange={vi.fn()} ariaLabel="Draft path" />);
    fireEvent.click(screen.getByRole('combobox'));
    const option = screen.getByRole('option');
    expect(option).toHaveTextContent(String.raw`C:\synthetic\models\draft.gguf`);
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(raw);
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('keeps the shared menu inside its modal and closes it when disabled', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const view = (disabled: boolean) => <OverlayContainerContext.Provider value={host}>
      <CustomSelect value="light" options={OPTIONS} onChange={vi.fn()} onInputChange={vi.fn()} disabled={disabled} ariaLabel="Runtime value" />
    </OverlayContainerContext.Provider>;
    const { rerender, unmount } = render(view(false));
    fireEvent.click(screen.getByRole('combobox'));
    expect(host).toContainElement(screen.getByRole('listbox'));
    rerender(view(true));
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    unmount(); host.remove();
  });

  it('closes on Tab and cannot choose portalled options after an enclosing fieldset is disabled', () => {
    const onChange = vi.fn();
    const view = (disabled: boolean) => <fieldset disabled={disabled}><CustomSelect value="light" options={OPTIONS} onChange={onChange} ariaLabel="Theme" /></fieldset>;
    const { rerender } = render(view(false));
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    rerender(view(true));
    fireEvent.click(screen.getByRole('option', { name: 'Dark' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('has no axe-core violations for an editable dropdown', async () => {
    const { container } = render(<CustomSelect value="light" options={OPTIONS} onChange={vi.fn()} onInputChange={vi.fn()} ariaLabel="Runtime value" />);
    fireEvent.click(screen.getByRole('combobox'));
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it.each(["explicit", "wrapping"])("focuses without opening when the %s label is clicked", (labelType) => {
    const select = <CustomSelect id="theme" value="light" options={OPTIONS} onChange={vi.fn()} />;
    render(labelType === "explicit"
      ? <><label htmlFor="theme"><span>Theme</span></label>{select}</>
      : <label><span>Theme</span>{select}</label>);
    const trigger = screen.getByRole("combobox", { name: /Theme/ });

    fireEvent.click(screen.getByText("Theme"));
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Light"));
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps label focus separate from keyboard and assistive activation", () => {
    render(<><label htmlFor="theme">Theme</label><CustomSelect id="theme" value="light" options={OPTIONS} onChange={vi.fn()} /></>);
    const trigger = screen.getByRole("combobox", { name: "Theme" });
    fireEvent.click(screen.getByText("Theme"));
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(trigger, { key: "Escape" });
    fireEvent.click(trigger, { detail: 0 });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("does not cancel interactive content within a wrapping label", () => {
    const onHelp = vi.fn();
    render(<label><span>Theme</span><CustomSelect value="light" options={OPTIONS} onChange={vi.fn()} /><button type="button" onClick={(event) => onHelp(event.defaultPrevented)}>Help</button></label>);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(onHelp).toHaveBeenCalledWith(false);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });

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
