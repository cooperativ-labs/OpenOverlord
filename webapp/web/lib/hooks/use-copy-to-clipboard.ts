import { useCallback, useState } from 'react';

export function useCopyToClipboard({ resetMs = 2000 }: { resetMs?: number } = {}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    async (value: string) => {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), resetMs);
    },
    [resetMs]
  );

  return { copied, copy };
}
