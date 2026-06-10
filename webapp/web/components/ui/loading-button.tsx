import { Check, Loader2 } from 'lucide-react';
import { type ComponentProps, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

export type ButtonLoadingState = 'default' | 'loading' | 'success' | 'error' | 'disabled';

type LoadingButtonProps = Omit<ComponentProps<typeof Button>, 'onClick'> & {
  buttonState: ButtonLoadingState;
  setButtonState?: (state: ButtonLoadingState) => void;
  text: ReactNode;
  loadingText?: ReactNode;
  successText?: ReactNode;
  errorText?: ReactNode;
  reset?: boolean;
  onClick?: () => void | Promise<void>;
};

export function LoadingButton({
  buttonState,
  setButtonState,
  text,
  loadingText,
  successText,
  errorText,
  reset = false,
  onClick,
  disabled: disabledFromProps,
  ...props
}: LoadingButtonProps) {
  const isLoading = buttonState === 'loading';
  const isDisabled = buttonState === 'disabled' || isLoading || Boolean(disabledFromProps);

  async function handleClick() {
    if (isDisabled || !onClick) return;
    await onClick();
    if (reset && setButtonState) {
      setTimeout(() => setButtonState('default'), 2000);
    }
  }

  function getContent() {
    switch (buttonState) {
      case 'loading':
        return (
          <>
            <Loader2 className="animate-spin" />
            {loadingText ?? text}
          </>
        );
      case 'success':
        return (
          <>
            <Check />
            {successText ?? text}
          </>
        );
      case 'error':
        return errorText ?? text;
      default:
        return text;
    }
  }

  return (
    <Button {...props} disabled={isDisabled} onClick={handleClick}>
      {getContent()}
    </Button>
  );
}
