// Barrel for the local-target capability contract (R2). Import from here:
//   import { LocalTargetProviderRegistry, ok, fail } from '.../local-target/index.ts';
export * from './types.ts';
export * from './result.ts';
export * from './registry.ts';
export { InProcessProvider } from './in-process-provider.ts';
export { deriveResourceStatus, resolveBackendResourceProvider } from './resource-status.ts';
export { PROJECT_JSON_VERSION, writeProjectJson } from './project-metadata.ts';
export { FakeLocalTargetProvider } from './fake-provider.ts';
export type { FakeHandlers, FakeProviderOptions } from './fake-provider.ts';
export { RunnerQueueProvider } from './runner-queue-provider.ts';
export {
  createDefaultLocalTargetRegistry,
  resolveDefaultLocalTargetProvider,
  type DefaultLocalTargetRegistryOptions
} from './default-registry.ts';
