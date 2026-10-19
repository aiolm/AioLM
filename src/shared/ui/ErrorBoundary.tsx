import React from "react";
import EmptyState from "./EmptyState";
import type { Locale } from "../i18n/i18n";
import { renderErrorCopy } from '../i18n/renderErrorCopy';

type Props = { children: React.ReactNode; label?: string };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("aiolm render error", error, info.componentStack);
  }

  private recover = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const language = document.documentElement.lang.split("-")[0];
    const locale: Locale = language === "ko" || language === "ja" || language === "zh" || language === "en" ? language : "en";
    const copy = renderErrorCopy[locale];
    return (
      <div className="app-runtime-empty" role="alert">
        <EmptyState
          title={this.props.label ? copy.namedTitle.replace('{screen}', this.props.label) : copy.title}
          description={copy.hint}
          action={{ label: copy.retry, onClick: this.recover }}
          icon="!"
        >
          <details className="mt-3 max-w-full text-left">
            <summary className="cursor-pointer text-sm">{copy.details}</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{this.state.error.message}</pre>
          </details>
        </EmptyState>
      </div>
    );
  }
}

export function PanelBoundary({ label, children }: Props) {
  return <ErrorBoundary label={label}>{children}</ErrorBoundary>;
}
