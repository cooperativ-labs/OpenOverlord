import { useState } from 'react';

import {
  sanitizeWorkspaceIdInput,
  sanitizeWorkspaceSlugInput,
  suggestWorkspaceId,
  suggestWorkspaceSlug
} from '@/lib/workspace-slug';

export function useWorkspaceCreationForm() {
  const [name, setName] = useState('');
  // Until the operator edits the ID themselves, it follows the suggestion
  // derived from the full workspace name; clearing the field hands control back.
  const [idOverride, setIdOverride] = useState<string | null>(null);
  // Until the operator edits the slug themselves, it follows the suggestion
  // derived from the name; clearing the field hands control back.
  const [slugOverride, setSlugOverride] = useState<string | null>(null);

  const suggestedId = suggestWorkspaceId(name);
  const workspaceId = idOverride ?? suggestedId;
  const suggestedSlug = suggestWorkspaceSlug(name);
  const slug = slugOverride ?? suggestedSlug;
  const exampleSlug = slug || 'abc';

  function setWorkspaceIdFromInput(value: string) {
    const next = sanitizeWorkspaceIdInput(value);
    setIdOverride(next === '' ? null : next);
  }

  function setSlugFromInput(value: string) {
    const next = sanitizeWorkspaceSlugInput(value);
    setSlugOverride(next === '' ? null : next);
  }

  function reset() {
    setName('');
    setIdOverride(null);
    setSlugOverride(null);
  }

  function getSubmitBody(): { id?: string; name: string; slug?: string } {
    return { id: workspaceId || undefined, name: name.trim(), slug: slug || undefined };
  }

  return {
    name,
    setName,
    workspaceId,
    setWorkspaceIdFromInput,
    slug,
    setSlugFromInput,
    exampleSlug,
    reset,
    getSubmitBody
  };
}
