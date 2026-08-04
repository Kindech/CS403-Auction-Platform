import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in UI:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="max-w-lg mx-auto mt-20 text-center">
          <h1 className="text-xl font-semibold text-red-400 mb-2">Something went wrong</h1>
          <p className="text-slate-400 text-sm">{this.state.error.message}</p>
          <button
            className="mt-6 rounded bg-slate-800 hover:bg-slate-700 px-4 py-2"
            onClick={() => {
              this.setState({ error: null });
              window.location.href = "/";
            }}
          >
            Back to dashboard
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
