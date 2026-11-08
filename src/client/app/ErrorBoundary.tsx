import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props { children: ReactNode; fallback?: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo): void { console.error('UI error', error, info.componentStack); }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return <div role="alert" style={{ padding: 32, fontFamily: 'system-ui, sans-serif' }}>
      <h2>發生錯誤</h2>
      <p>{this.state.error.message}</p>
      <button type="button" onClick={() => window.location.reload()}>重新載入</button>
    </div>;
  }
}
