import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ActionMenu, { type ActionMenuItem } from "./ActionMenu";

function renderMenu(overrides: Partial<Record<"probe" | "remove", Partial<ActionMenuItem>>> = {}) {
  const probe = vi.fn();
  const remove = vi.fn();
  render(<>
    <ActionMenu label="Build actions: Vulkan b100" items={[
      { id: "probe", label: "Probe", onSelect: probe, ...overrides.probe },
      { id: "remove", label: "Remove", tone: "danger", onSelect: remove, ...overrides.remove },
    ]} />
    <button type="button">Elsewhere</button>
  </>);
  return { probe, remove, trigger: screen.getByRole("button", { name: "Build actions: Vulkan b100" }) };
}

describe("ActionMenu", () => {
  it("opens from the keyboard, moves between items and returns focus on Escape", () => {
    const { trigger } = renderMenu();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Build actions: Vulkan b100" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Probe" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Probe" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("runs the chosen action once and closes", () => {
    const { trigger, remove, probe } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Probe" }), { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps an unavailable action inert and states why", () => {
    const { trigger, probe } = renderMenu({ probe: { disabled: true, description: "Unload the model first." } });
    fireEvent.click(trigger);
    const item = screen.getByRole("menuitem", { name: "Probe" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleDescription("Unload the model first.");
    fireEvent.click(item);
    expect(probe).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("lets a blocked action report its reason", () => {
    const { trigger, remove } = renderMenu({ remove: { blocked: true, description: "Unload the model before removing runtimes." } });
    fireEvent.click(trigger);
    const item = screen.getByRole("menuitem", { name: "Remove" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(item);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("closes on a pointer outside the menu", () => {
    const { trigger } = renderMenu();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
