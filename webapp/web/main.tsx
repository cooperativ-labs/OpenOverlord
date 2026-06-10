import './styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ThemeProvider } from './components/theme-provider.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { RealtimeProvider } from './lib/realtime.tsx';
import { router } from './router.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The realtime feed drives freshness; avoid redundant background refetches.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element #root not found');

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <RealtimeProvider>
            <RouterProvider router={router} />
          </RealtimeProvider>
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
);
