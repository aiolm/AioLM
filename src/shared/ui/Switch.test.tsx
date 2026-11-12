import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import Switch from "./Switch";

describe("Switch", () => {
  it("takes its accessible name from an associated label", () => {
    render(<>
      <label htmlFor="toggle">Enter to send</label>
      <Switch id="toggle" checked={false} onChange={() => undefined} />
    </>);
    const control = screen.getByRole("switch", { name: "Enter to send" });
    expect(control).toHaveAttribute("aria-checked", "false");
  });

  it("forwards the visible name and description to the switch control", () => {
    render(<>
      <span id="toggle-label">Start automatically</span>
      <p id="toggle-description">Start the configured server when the app opens.</p>
      <Switch id="toggle" checked={false} onChange={() => undefined} aria-labelledby="toggle-label" aria-describedby="toggle-description" />
    </>);
    const control = screen.getByRole("switch", { name: "Start automatically" });
    expect(control).toHaveAccessibleDescription("Start the configured server when the app opens.");
  });

  it("reports the checked state and toggles to the opposite value", () => {
    const onChange = vi.fn();
    render(<Switch id="toggle" checked onChange={onChange} />);
    const control = screen.getByRole("switch");
    expect(control).toHaveAttribute("aria-checked", "true");
    control.click();
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not fire while disabled", () => {
    const onChange = vi.fn();
    render(<Switch id="toggle" checked={false} onChange={onChange} disabled />);
    screen.getByRole("switch").click();
    expect(onChange).not.toHaveBeenCalled();
  });
});
