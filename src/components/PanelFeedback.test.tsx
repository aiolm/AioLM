import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PanelFeedback, { ActivePanelContext, PanelFeedbackIndicator, PanelFeedbackOutlet, PanelFeedbackProvider } from "./PanelFeedback";
import FeedbackBanner from "./FeedbackBanner";
import { I18nProvider } from "../i18n";

describe("panel notices", () => {
  it("keeps notices actionable in the shared drawer and only includes the active page", () => {
    const retry = vi.fn();
    function Fixture() {
      const [active, setActive] = useState(true);
      const [error, setError] = useState(true);
      return <PanelFeedbackProvider>
        <button onClick={() => setActive(value => !value)}>Navigate</button>
        <div data-testid="page"><ActivePanelContext.Provider value={active}>
          <PanelFeedback>{error && <div role="alert">Load failed<button onClick={retry}>Retry</button><button onClick={() => setError(false)}>Dismiss</button></div>}</PanelFeedback>
        </ActivePanelContext.Provider></div>
        <div data-testid="indicator"><PanelFeedbackIndicator message="Check notices" globalError={false} /></div>
        <div data-testid="drawer"><PanelFeedbackOutlet /></div>
      </PanelFeedbackProvider>;
    }
    render(<I18nProvider initialLocale="en"><Fixture /></I18nProvider>);
    expect(within(screen.getByTestId("page")).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("drawer")).getByRole("alert")).toHaveTextContent("Load failed");
    expect(screen.getByTestId("indicator")).toHaveTextContent("Check notices");
    fireEvent.click(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Navigate"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("indicator")).not.toHaveTextContent("Check notices");
    fireEvent.click(screen.getByText("Navigate"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("indicator")).not.toHaveTextContent("Check notices");
  });

  it("shows successful saves as notices and updates severity even when the notice count stays the same", () => {
    function Fixture() {
      const [tone, setTone] = useState<"info" | "success" | "error">("info");
      const [globalError, setGlobalError] = useState(false);
      return <I18nProvider initialLocale="en"><PanelFeedbackProvider>
        <button onClick={() => setTone("success")}>Success</button>
        <button onClick={() => setTone("error")}>Fail</button>
        <button onClick={() => setGlobalError(true)}>Global error</button>
        <PanelFeedback><FeedbackBanner tone={tone}>Save result</FeedbackBanner></PanelFeedback>
        <div data-testid="indicator"><PanelFeedbackIndicator message="Check notices" globalError={globalError} /></div>
        <PanelFeedbackOutlet />
      </PanelFeedbackProvider></I18nProvider>;
    }
    render(<Fixture />);
    const indicator = screen.getByTestId("indicator");
    expect(indicator).toHaveTextContent("1 notices");
    expect(indicator.querySelector(".app-activity-error")).toBeNull();
    fireEvent.click(screen.getByText("Success"));
    expect(indicator).toHaveTextContent("1 notices");
    fireEvent.click(screen.getByText("Fail"));
    expect(indicator).toHaveTextContent("Check notices");
    expect(indicator.querySelector(".app-activity-error")).not.toBeNull();
    fireEvent.click(screen.getByText("Success"));
    expect(indicator).toHaveTextContent("1 notices");
    fireEvent.click(screen.getByText("Global error"));
    expect(indicator).toHaveTextContent("Check notices");
  });

  it("renders standalone notices inline and renders nothing for empty children", () => {
    const { rerender, container } = render(<PanelFeedback>{false}{null}</PanelFeedback>);
    expect(container).toBeEmptyDOMElement();
    rerender(<PanelFeedback><div role="status">Saved</div></PanelFeedback>);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });
});
