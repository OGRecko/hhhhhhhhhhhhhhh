import React from 'react';

interface State { error: Error | null }

/**
 * Isolates the WebGL viewport. If WebGL is unavailable or the context is lost
 * (e.g. no GPU / software rendering disabled) only the viewport shows a notice;
 * the side panels, solver and report generation keep working.
 */
export default class ViewportGuard extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Viewport failed:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="w-full h-full flex items-center justify-center bg-[#0b0b0c] text-white/80 p-6" data-testid="viewport-fallback">
        <div className="max-w-sm text-center space-y-3">
          <h2 className="text-base font-semibold">3D view unavailable</h2>
          <p className="text-sm text-white/60">
            This device could not start WebGL graphics. Room setup, simulation, results and reports still work.
            Updating your graphics driver usually fixes this.
          </p>
          <button className="px-3 py-1.5 text-sm rounded border border-white/20 hover:bg-white/10"
            onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
