// Result constructors and guards for the local-target capability contract.
// Keeping these tiny helpers in one place means providers never hand-assemble
// the discriminated union (and never forget the `target` metadata).

import type {
  CapabilityFailure,
  CapabilityResult,
  CapabilitySuccess,
  LocalTargetErrorCode,
  TargetMetadata
} from './types.ts';

/** Build a success result carrying the originating target metadata. */
export function ok<T>(target: TargetMetadata, value: T): CapabilitySuccess<T> {
  return { ok: true, value, target };
}

/** Build a typed failure result carrying the originating target metadata. */
export function fail(
  target: TargetMetadata,
  code: LocalTargetErrorCode,
  message: string,
  details?: unknown
): CapabilityFailure {
  return details === undefined
    ? { ok: false, code, message, target }
    : { ok: false, code, message, details, target };
}

/** Narrow a result to its success branch. */
export function isOk<T>(result: CapabilityResult<T>): result is CapabilitySuccess<T> {
  return result.ok;
}

/** Narrow a result to its failure branch. */
export function isFailure<T>(result: CapabilityResult<T>): result is CapabilityFailure {
  return !result.ok;
}
