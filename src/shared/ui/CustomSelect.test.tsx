import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { Profiler, useState } from 'react';
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

function overrideResizeObserver(value: unknown) {
  const previous = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", value);
  return () => vi.stubGlobal("ResizeObserver", previous);
}

describe("CustomSelect", () => {
  it.each([false, true])('exposes invalid state and linked feedback on the actual combobox (editable: %s)', editable => {
    const content = (invalid?: boolean) => <>
      <p id="value-help">Choose a runtime value</p><p id="value-error">The saved value is unavailable</p>
      <CustomSelect ariaLabel="Runtime value" value="light" options={OPTIONS} onChange={vi.fn()}
        onInputChange={editable ? vi.fn() : undefined} ariaInvalid={invalid}
        ariaDescribedBy={invalid ? 'value-help value-error' : 'value-help'} />
    </>;
    const view = render(content(true));
    const control = screen.getByRole('combobox', { name: 'Runtime value' });
    expect(control.tagName).toBe(editable ? 'INPUT' : 'BUTTON');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription('Choose a runtime value The saved value is unavailable');
    view.rerender(content(false));
    expect(control).toHaveAttribute('aria-invalid', 'false');
    expect(control).toHaveAccessibleDescription('Choose a runtime value');
    view.rerender(content());
    expect(control).not.toHaveAttribute('aria-invalid');
  });

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

  it("does not rebind native label listeners for unrelated rerenders", () => {
    function Harness() {
      const [revision, setRevision] = useState(0);
      return <>
        <button type="button" onClick={() => setRevision(value => value + 1)}>Rerender</button>
        <label><span>Theme</span><CustomSelect value="light" options={OPTIONS} onChange={vi.fn()} /></label>
        <output>{revision}</output>
      </>;
    }

    render(<Harness />);
    const label = screen.getByText("Theme").closest("label");
    if (!label) throw new Error("Wrapping label not found.");
    const addListener = vi.spyOn(label, "addEventListener");
    const removeListener = vi.spyOn(label, "removeEventListener");

    fireEvent.click(screen.getByRole("button", { name: "Rerender" }));

    expect(addListener).not.toHaveBeenCalled();
    expect(removeListener).not.toHaveBeenCalled();
  });

  it("rebinds only the replaced native label while keeping focus-only activation", () => {
    function Harness() {
      const [revision, setRevision] = useState(0);
      return <>
        <button type="button" onClick={() => setRevision(value => value + 1)}>Replace label</button>
        <label key={revision} htmlFor="theme">Theme {revision}</label>
        <CustomSelect id="theme" value="light" options={OPTIONS} onChange={vi.fn()} />
      </>;
    }

    render(<Harness />);
    const trigger = screen.getByRole("combobox");
    fireEvent.click(screen.getByText("Replace label"));
    fireEvent.click(screen.getByText("Theme 1"));

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
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

  it("does not remeasure menu width when only the highlight changes", () => {
    const restoreResizeObserver = overrideResizeObserver(class TestResizeObserver {
      observe() {}
      disconnect() {}
    });
    const previousWidth = window.innerWidth;
    window.innerWidth = 800;
    let listboxMeasurements = 0;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "combobox") return { top: 100, bottom: 130, left: 100, right: 220, width: 120, height: 30 } as DOMRect;
      if (this.getAttribute("role") === "listbox") {
        listboxMeasurements += 1;
        return { top: 134, bottom: 300, left: 100, right: 220, width: 120, height: 166 } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    try {
      renderSelect();
      const trigger = screen.getByRole("combobox", { name: "Theme" });
      fireEvent.click(trigger);
      const measurementsAfterOpen = listboxMeasurements;

      fireEvent.keyDown(trigger, { key: "ArrowDown" });

      expect(listboxMeasurements).toBe(measurementsAfterOpen);
    } finally {
      rect.mockRestore();
      window.innerWidth = previousWidth;
      restoreResizeObserver();
    }
  });

  it("keeps the render-driven geometry fallback when ResizeObserver is unavailable", () => {
    const restoreResizeObserver = overrideResizeObserver(undefined);
    let listboxMeasurements = 0;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "combobox") return { top: 100, bottom: 130, left: 100, right: 220, width: 120, height: 30 } as DOMRect;
      if (this.getAttribute("role") === "listbox") {
        listboxMeasurements += 1;
        return { top: 134, bottom: 300, left: 100, right: 220, width: 120, height: 166 } as DOMRect;
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    try {
      renderSelect();
      const trigger = screen.getByRole("combobox", { name: "Theme" });
      fireEvent.click(trigger);
      const measurementsAfterOpen = listboxMeasurements;

      fireEvent.keyDown(trigger, { key: "ArrowDown" });

      expect(listboxMeasurements).toBeGreaterThan(measurementsAfterOpen);
    } finally {
      rect.mockRestore();
      restoreResizeObserver();
    }
  });

  it("rechecks a mutable options array in the legacy geometry fallback", () => {
    const restoreResizeObserver = overrideResizeObserver(undefined);
    const previousWidth = window.innerWidth;
    window.innerWidth = 360;
    const options = [{ value: "one", label: "Short" }, { value: "two", label: "Second" }];
    const renderedWidth = { current: 110 };
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "combobox") return { top: 100, bottom: 130, left: 242, right: 352, width: 110, height: 30 } as DOMRect;
      if (this.getAttribute("role") === "listbox") return {
        top: 134, bottom: 300, left: parseFloat(this.style.left), right: parseFloat(this.style.left) + renderedWidth.current,
        width: renderedWidth.current, height: 166,
      } as DOMRect;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    try {
      function Harness() {
        const [, setRevision] = useState(0);
        return <>
          <button type="button" onClick={() => setRevision(value => value + 1)}>Rerender mutable options</button>
          <CustomSelect value="one" options={options} onChange={vi.fn()} ariaLabel="Mutable" />
        </>;
      }

      render(<Harness />);
      fireEvent.click(screen.getByRole("combobox", { name: "Mutable" }));
      expect(screen.getByRole("listbox").style.left).toBe("242px");

      renderedWidth.current = 344;
      options[0].label = "A long label mutated while the menu is open";
      fireEvent.click(screen.getByRole("button", { name: "Rerender mutable options" }));

      expect(screen.getByRole("listbox").style.left).toBe("8px");
    } finally {
      rect.mockRestore();
      window.innerWidth = previousWidth;
      restoreResizeObserver();
    }
  });

  it("does not rerender the menu when a viewport event leaves its geometry unchanged", () => {
    const restoreResizeObserver = overrideResizeObserver(class TestResizeObserver {
      observe() {}
      disconnect() {}
    });
    const previousWidth = window.innerWidth;
    window.innerWidth = 800;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "combobox") return { top: 100, bottom: 130, left: 100, right: 220, width: 120, height: 30 } as DOMRect;
      if (this.getAttribute("role") === "listbox") return { top: 134, bottom: 300, left: 100, right: 220, width: 120, height: 166 } as DOMRect;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    try {
      let commits = 0;
      render(<Profiler id="custom-select" onRender={() => { commits += 1; }}><CustomSelect id="theme" value="light" options={OPTIONS} onChange={vi.fn()} ariaLabel="Theme" /></Profiler>);
      fireEvent.click(screen.getByRole("combobox", { name: "Theme" }));
      const commitsAfterOpen = commits;

      fireEvent(window, new Event("resize"));

      expect(commits).toBe(commitsAfterOpen);
    } finally {
      rect.mockRestore();
      window.innerWidth = previousWidth;
      restoreResizeObserver();
    }
  });

  it("repositions an open menu when the trigger size changes", () => {
    const previousWidth = window.innerWidth;
    window.innerWidth = 800;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "combobox") {
        const height = this.className.includes("app-custom-select-trigger--sm") ? 20 : 40;
        return { top: 100, bottom: 100 + height, left: 100, right: 220, width: 120, height } as DOMRect;
      }
      if (this.getAttribute("role") === "listbox") return { top: 144, bottom: 300, left: 100, right: 220, width: 120, height: 156 } as DOMRect;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    try {
      const { rerender } = render(<CustomSelect value="light" options={OPTIONS} onChange={vi.fn()} ariaLabel="Theme" />);
      const trigger = screen.getByRole("combobox", { name: "Theme" });
      fireEvent.click(trigger);
      expect(screen.getByRole("listbox")).toHaveStyle({ top: "144px" });

      rerender(<CustomSelect value="light" options={OPTIONS} onChange={vi.fn()} ariaLabel="Theme" size="sm" />);

      expect(screen.getByRole("listbox")).toHaveStyle({ top: "124px" });
    } finally {
      rect.mockRestore();
      window.innerWidth = previousWidth;
    }
  });

  it("lowercases an editable query once instead of once per option", () => {
    const original = String.prototype.toLocaleLowerCase;
    let queryLowercaseCalls = 0;
    const lower = vi.spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function (this: string) {
      if (this === "NEEDLE") queryLowercaseCalls += 1;
      return original.call(this);
    });
    try {
      render(<CustomSelect value="" options={Array.from({ length: 80 }, (_, index) => ({ value: String(index), label: `Option ${index}` }))}
        onChange={vi.fn()} onInputChange={vi.fn()} ariaLabel="Search" />);
      fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value: "NEEDLE" } });

      expect(queryLowercaseCalls).toBe(1);
    } finally {
      lower.mockRestore();
    }
  });
  describe("in a 360px window with a narrow trigger at the right edge", () => {
    const RUNTIMES = ["private-000000000001", "private-000000000002"].map(id => ({ value: id, label: `synthetic-dynamic-v1 (${id}) · cpu · external` }));
    const box = (x: number, y: number, width: number, height: number) => ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => undefined }) as DOMRect;
    /** Stands in for layout: the listbox reports the width its options would give it. */
    function layout(renderedWidth: { current: number }, run: () => void) {
      const innerWidth = window.innerWidth;
      window.innerWidth = 360;
      const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("role") === "combobox") return box(242, 100, 110, 30);
        if (this.getAttribute("role") === "listbox") return box(parseFloat(this.style.left), 134, renderedWidth.current, 200);
        return box(0, 0, 0, 0);
      });
      try { run(); } finally { rect.mockRestore(); window.innerWidth = innerWidth; }
    }

    it.each([
      // Long runtime labels lay the menu out wider than its trigger.
      { renderedWidth: 344, left: 8 },
      // A menu that fits beside its trigger stays aligned with it.
      { renderedWidth: 110, left: 242 },
    ])("keeps a $renderedWidth px menu inside the viewport", ({ renderedWidth, left }) => layout({ current: renderedWidth }, () => {
      render(<CustomSelect value={RUNTIMES[0].value} options={RUNTIMES} onChange={vi.fn()} ariaLabel="Runtime" />);
      fireEvent.click(screen.getByRole("combobox", { name: "Runtime" }));
      const menu = screen.getByRole("listbox").getBoundingClientRect();
      expect(menu.left).toBe(left);
      expect(menu.right).toBeLessThanOrEqual(360 - 8);
      expect(screen.getByRole("listbox").style.minWidth).toBe("110px");
    }));

    it("re-fits the open menu when longer options arrive", () => {
      const renderedWidth = { current: 110 };
      layout(renderedWidth, () => {
        const choose = [{ value: "", label: "Choose a runtime" }];
        const { rerender } = render(<CustomSelect value="" options={choose} onChange={vi.fn()} ariaLabel="Runtime" />);
        fireEvent.click(screen.getByRole("combobox", { name: "Runtime" }));
        expect(screen.getByRole("listbox").getBoundingClientRect().left).toBe(242);
        renderedWidth.current = 344;
        rerender(<CustomSelect value="" options={[...choose, ...RUNTIMES]} onChange={vi.fn()} ariaLabel="Runtime" />);
        expect(screen.getByRole("listbox").getBoundingClientRect().right).toBeLessThanOrEqual(360 - 8);
      });
    });

    it("keeps the final clamped right edge after a viewport update", () => {
      const renderedWidth = { current: 344 };
      layout(renderedWidth, () => {
        render(<CustomSelect value={RUNTIMES[0].value} options={RUNTIMES} onChange={vi.fn()} ariaLabel="Runtime" />);
        const trigger = screen.getByRole("combobox", { name: "Runtime" });
        fireEvent.click(trigger);
        const menu = screen.getByRole("listbox");

        expect(menu.style.left).toBe("8px");
        fireEvent(window, new Event("resize"));

        expect(menu.style.left).toBe("8px");
        expect(menu.getBoundingClientRect().right).toBe(352);
      });
    });
  });

  it("links the trigger to the listbox and to the highlighted option", () => {
    const { trigger } = renderSelect();
    expect(trigger).not.toHaveAttribute("aria-activedescendant");
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Theme" });
    expect(trigger).toHaveAttribute("aria-controls", listbox.id);
    expect(trigger).toHaveAttribute("aria-activedescendant", `${listbox.id}-option-0`);
  });

  it("references the listbox only while it is rendered", () => {
    const { trigger } = renderSelect();
    expect(trigger).not.toHaveAttribute("aria-controls");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.getElementById(trigger.getAttribute("aria-controls") ?? "")).toHaveAttribute("role", "listbox");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).not.toHaveAttribute("aria-controls");
  });

  it.each(["explicit", "wrapping"])("names the listbox from a %s native label without the selected value", (labelType) => {
    const select = <CustomSelect id="backend" value="light" options={OPTIONS} onChange={vi.fn()} />;
    render(labelType === "explicit"
      ? <><label htmlFor="backend">Backend</label>{select}</>
      : <label><span>Backend</span>{select}</label>);
    fireEvent.click(screen.getByRole("combobox", { name: /Backend/ }));
    expect(screen.getByRole("listbox", { name: "Backend" })).toBeInTheDocument();
  });

  it("moves the highlight on arrow keys without committing a value", () => {
    const { trigger, onChange } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-activedescendant", expect.stringContaining("-option-1"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("styles the moving highlight apart from the committed selection", () => {
    const { trigger } = renderSelect();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const [committed, highlighted] = screen.getAllByRole("option");
    expect(committed).toHaveClass("is-selected");
    expect(committed).not.toHaveClass("is-highlighted");
    expect(highlighted).toHaveClass("is-highlighted");
    expect(highlighted).not.toHaveClass("is-selected");
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
