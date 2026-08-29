import { Component, type ErrorInfo, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="boot" role="alert">
        <h1>Something went wrong</h1>
        <p>Reload the page to try again.</p>
        <button className="retry" type="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    );
  }
}
