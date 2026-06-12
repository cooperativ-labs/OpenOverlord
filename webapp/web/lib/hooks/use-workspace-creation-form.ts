import { useState } from 'react';

import { sanitizeWorkspaceSlugInput, suggestWorkspaceSlug } from '@/lib/workspace-slug';

export function useWorkspaceCreationForm() {
  const [name, setName] = useState('');
  // Until the operator edits the slug themselves, it follows the suggestion
  // derived from the name; clearing the field hands control back.
  const [slugOverride, setSlugOverride] = useState<string | null>(null);

  const suggestedSlug = suggestWorkspaceSlug(name);
  const slug = slugOverride ?? suggestedSlug;
  const exampleSlug = slug || 'abc';

  function setSlugFromInput(value: string) {
    const next = sanitizeWorkspaceSlugInput(value);
    setSlugOverride(next === '' ? null : next);
  }

  function reset() {
    setName('');
    setSlugOverride(null);
  }

  function getSubmitBody(): { name: string; slug?: string } {
    return { name: name.trim(), slug: slug || undefined };
  }

  return {
    name,
    setName,
    slug,
    setSlugFromInput,
    exampleSlug,
    reset,
    getSubmitBody
  };
}
