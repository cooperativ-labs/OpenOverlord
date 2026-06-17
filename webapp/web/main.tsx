import './styles.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { AuthGate } from './components/auth/AuthGate.tsx';
import {
  SystemNotificationProvider,
  SystemNotificationRoot
} from './components/system-notifications';
import { ThemeProvider } from './components/theme-provider.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { applyDesktopChromeDocumentAttributes } from './lib/desktop-chrome.ts';
import { syncDesktopNativeTheme } from './lib/desktop-native-theme.ts';
import { RealtimeProvider } from './lib/realtime.tsx';
import { router } from './router.tsx';

applyDesktopChromeDocumentAttributes();
syncDesktopNativeTheme();

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
          <AuthGate>
            <SystemNotificationProvider>
              <RealtimeProvider>
                <RouterProvider router={router} />
              </RealtimeProvider>
              <SystemNotificationRoot />
            </SystemNotificationProvider>
          </AuthGate>
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>
);
