import { GalleryVerticalEnd } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { BackendLoginPanel } from '@/components/auth/BackendLoginPanel';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type ButtonLoadingState, LoadingButton } from '@/components/ui/loading-button';
import { persistAuthSessionFromSignInResult } from '@/lib/api-base';
import { authClient, normalizeEmail, validateEmail } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

type AuthMode = 'sign-in' | 'create-account';

type AuthScreenProps = {
  onAuthenticated: () => Promise<void> | void;
};

function authErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim();
    if (message) return message;
  }
  return 'Authentication failed.';
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitButtonState, setSubmitButtonState] = useState<ButtonLoadingState>('default');

  const isCreate = mode === 'create-account';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const emailError = validateEmail(email);
    if (emailError) {
      setError(emailError);
      setSubmitButtonState('error');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      setSubmitButtonState('error');
      return;
    }

    setError(null);
    setSubmitButtonState('loading');
    try {
      const normalizedEmail = normalizeEmail(email);
      const result = isCreate
        ? await authClient.signUp.email({
            email: normalizedEmail,
            password,
            name: normalizedEmail.split('@')[0] ?? normalizedEmail
          })
        : await authClient.signIn.email({ email: normalizedEmail, password });

      if (result.error) {
        setError(result.error.message ?? 'Authentication failed.');
        setSubmitButtonState('error');
        return;
      }

      setSubmitButtonState('success');
      await persistAuthSessionFromSignInResult(result.data);
      await onAuthenticated();
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitButtonState('error');
    }
  }

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
    setSubmitButtonState('default');
  }

  return (
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-8 overflow-hidden">
      <div className="electron-drag-region shrink-0" />
      <div className="flex flex-col items-center justify-center px-4 py-8">
        <img
          src="/images/256.png"
          alt="Overlord"
          className="h-32 w-32 rounded-4xl object-contain"
          width={128}
          height={128}
        />
      </div>

      <main className="flex w-full items-center justify-center px-4 pb-8">
        <div className="flex w-full max-w-md flex-col gap-6">
          <BackendLoginPanel />

          {error ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <form className={cn('flex flex-col gap-6')} onSubmit={handleSubmit}>
            <FieldGroup>
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="flex flex-col items-center gap-2 font-medium">
                  <div className="flex size-8 items-center justify-center rounded-md">
                    <GalleryVerticalEnd className="size-6" />
                  </div>
                  <span className="sr-only">Overlord</span>
                </div>
                <h1 className="text-xl font-bold">
                  {isCreate ? 'Welcome to Overlord' : 'Welcome back'}
                </h1>
                <FieldDescription>
                  {isCreate ? (
                    <>
                      Already have an account?{' '}
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => switchMode('sign-in')}
                      >
                        Sign in
                      </button>
                    </>
                  ) : (
                    <>
                      Don&apos;t have an account?{' '}
                      <button
                        type="button"
                        className="underline underline-offset-4"
                        onClick={() => switchMode('create-account')}
                      >
                        Create account
                      </button>
                    </>
                  )}
                </FieldDescription>
              </div>

              <Field>
                <FieldLabel htmlFor="auth-email">Email</FieldLabel>
                <Input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  disabled={submitButtonState === 'loading'}
                  autoFocus
                  required
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="auth-password">Password</FieldLabel>
                <Input
                  id="auth-password"
                  type="password"
                  autoComplete={isCreate ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  disabled={submitButtonState === 'loading'}
                  required
                  minLength={8}
                />
              </Field>

              <Field>
                <LoadingButton
                  type="submit"
                  className="w-full"
                  buttonState={submitButtonState}
                  setButtonState={setSubmitButtonState}
                  text={isCreate ? 'Create Account' : 'Sign in'}
                  loadingText={isCreate ? 'Creating account...' : 'Signing in...'}
                  successText={isCreate ? 'Account created' : 'Signed in'}
                  errorText={isCreate ? 'Sign up failed' : 'Sign in failed'}
                />
              </Field>
            </FieldGroup>
          </form>
        </div>
      </main>
    </div>
  );
}
