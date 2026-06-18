import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button, EmptyState } from './ui.tsx';

type ProjectWorkspaceErrorBoundaryProps = {
  children: ReactNode;
  region: string;
};

type ProjectWorkspaceErrorBoundaryState = {
  error: Error | null;
};

export class ProjectWorkspaceErrorBoundary extends Component<
  ProjectWorkspaceErrorBoundaryProps,
  ProjectWorkspaceErrorBoundaryState
> {
  state: ProjectWorkspaceErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ProjectWorkspaceErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Project workspace error (${this.props.region}):`, error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-8">
          <EmptyState
            title={`Something went wrong in the ${this.props.region}`}
            hint={
              this.state.error.message || 'An unexpected error occurred while rendering this view.'
            }
            action={
              <Button variant="primary" onClick={this.handleRetry}>
                Try again
              </Button>
            }
          />
        </div>
      );
    }

    return this.props.children;
  }
}
