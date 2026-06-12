export function normalizeInstructionText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/**
 * Derives a short title from objective instruction text without calling a model.
 */
export function deriveTitleFromInstructionText(instructionText: string): string {
  const trimmed = normalizeInstructionText(instructionText);
  if (trimmed.length <= 100) {
    return trimmed;
  }

  return `${trimmed.slice(0, 100)}…`;
}
