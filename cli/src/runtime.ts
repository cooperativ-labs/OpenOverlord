import { type BackendClient, createBackendClient } from './backend-client.js';

export type CliRuntime = {
  backend: BackendClient;
  close: () => void;
};

export function openCliRuntime(): CliRuntime {
  const backend = createBackendClient();
  return {
    backend,
    close: () => {}
  };
}
