import './styles.css';

import { initApiConfig } from './lib/api-base.ts';
import { registerPwa } from './register-pwa.ts';

void initApiConfig().then(async () => {
  await import('./bootstrap-app.tsx');
  void registerPwa();
});
