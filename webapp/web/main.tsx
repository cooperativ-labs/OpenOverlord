import './styles.css';

import { initDesktopApiConfig } from './lib/api-base.ts';

void initDesktopApiConfig().then(async () => {
  await import('./bootstrap-app.tsx');
});
