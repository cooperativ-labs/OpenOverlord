import { Check, Copy } from 'lucide-react';

import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';

type CopyTicketIdentifierButtonProps = {
  value: string;
  className?: string;
  ariaLabel?: string;
};

export function CopyTicketIdentifierButton({
  value,
  className,
  ariaLabel
}: CopyTicketIdentifierButtonProps) {
  const { copied, copy } = useCopyToClipboard();

  async function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    await copy(value);
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? 'Copy ticket identifier'}
      className={className}
      onClick={handleClick}
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
