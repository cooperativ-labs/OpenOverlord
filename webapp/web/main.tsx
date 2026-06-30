import './styles.css';

import { initApiConfig } from './lib/api-base.ts';

void initApiConfig().then(async () => {
  await import('./bootstrap-app.tsx');
});
