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
        <div className="max-w-lg mx-auto mt-20 text-center bg-white rounded-xl shadow-card border border-slate-100 p-8">
          <h1 className="font-serif-display text-xl font-semibold text-red-600 mb-2">เกิดข้อผิดพลาด</h1>
          <p className="text-ink-muted text-sm">{this.state.error.message}</p>
          <button
            className="mt-6 rounded-full bg-ink text-cream hover:bg-ink/90 px-4 py-2 text-sm font-semibold transition-colors"
            onClick={() => {
              this.setState({ error: null });
              window.location.href = "/";
            }}
          >
            กลับหน้าหลัก
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
