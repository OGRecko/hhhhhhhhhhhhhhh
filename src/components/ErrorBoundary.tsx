import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Cavity crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-screen h-screen flex items-center justify-center bg-[#0a0a0a] text-white">
          <div className="max-w-md text-center space-y-4 p-6">
            <h1 className="text-xl font-bold text-[#2563eb]">Something went wrong</h1>
            <p className="text-sm text-white/70">
              {this.state.error.message || 'The app hit an unexpected error and could not continue rendering.'}
            </p>
            <button
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
              className="px-4 py-2 bg-[#2563eb] text-black font-bold rounded hover:opacity-90 transition-opacity"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
