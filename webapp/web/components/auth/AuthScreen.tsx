import { type FormEvent, useState } from 'react';

import { BackendLoginPanel } from '@/components/auth/BackendLoginPanel';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type ButtonLoadingState, LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { persistAuthSessionFromSignInResult } from '@/lib/api-base';
import { authClient, normalizeEmail, validateEmail } from '@/lib/auth-client';

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
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [resendButtonState, setResendButtonState] = useState<ButtonLoadingState>('default');

  const isCreate = mode === 'create-account';
  // The backend chooser only exists in the desktop shell (Electron preload bridge).
  // In the browser/cloud build there is no bridge, so we skip the backend section and
  // its separator instead of rendering an empty inset box.
  const hasBackendChooser =
    typeof window !== 'undefined' && Boolean(window.overlord?.switchBackend);

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
            name: normalizedEmail.split('@')[0] ?? normalizedEmail,
            callbackURL: window.location.origin
          })
        : await authClient.signIn.email({ email: normalizedEmail, password });

      if (result.error) {
        if ((result.error as { code?: string }).code === 'EMAIL_NOT_VERIFIED') {
          setPendingVerificationEmail(normalizedEmail);
          setSubmitButtonState('default');
          return;
        }
        setError(result.error.message ?? 'Authentication failed.');
        setSubmitButtonState('error');
        return;
      }

      // Sign-up returns no session token when email verification is required
      // (auth/src/auth/config.ts, requireEmailVerification); show the
      // check-your-email screen instead of entering the app.
      if (!result.data?.token) {
        setPendingVerificationEmail(normalizedEmail);
        setSubmitButtonState('default');
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

  async function handleResendVerification() {
    if (!pendingVerificationEmail) return;
    setResendButtonState('loading');
    try {
      const result = await authClient.sendVerificationEmail({
        email: pendingVerificationEmail,
        callbackURL: window.location.origin
      });
      setResendButtonState(result.error ? 'error' : 'success');
    } catch {
      setResendButtonState('error');
    }
  }

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
    setSubmitButtonState('default');
    setPendingVerificationEmail(null);
    setResendButtonState('default');
  }

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div className="electron-drag-region absolute inset-x-0 top-0 h-10" />

      <main className="flex w-full flex-col items-center gap-6">
        <img
          src="/images/256.png"
          alt="Overlord"
          className="h-20 w-20 rounded-3xl object-contain drop-shadow-sm"
          width={80}
          height={80}
        />

        <div className="w-full max-w-sm rounded-2xl border bg-card p-6 shadow-lg shadow-black/5 ring-1 ring-black/5">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <h1 className="text-xl font-bold tracking-tight">
              {isCreate ? 'Welcome to Overlord' : 'Welcome back'}
            </h1>
            <FieldDescription>
              {isCreate ? (
                <>
                  Already have an account?{' '}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-4"
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
                    className="font-medium text-foreground underline underline-offset-4"
                    onClick={() => switchMode('create-account')}
                  >
                    Create account
                  </button>
                </>
              )}
            </FieldDescription>
          </div>

          {hasBackendChooser ? (
            <>
              <div className="mt-6 rounded-xl border bg-muted/40 p-4">
                <BackendLoginPanel embedded />
              </div>
              <Separator className="my-6" />
            </>
          ) : (
            <div className="mt-6" />
          )}

          {pendingVerificationEmail ? (
            <div className="flex flex-col gap-4 text-center">
              <p className="text-sm text-muted-foreground">
                We sent a verification link to <strong>{pendingVerificationEmail}</strong>. Follow
                the link to finish signing in.
              </p>
              <LoadingButton
                type="button"
                variant="outline"
                className="w-full"
                buttonState={resendButtonState}
                setButtonState={setResendButtonState}
                onClick={handleResendVerification}
                text="Resend email"
                loadingText="Sending..."
                successText="Email sent"
                errorText="Couldn't send — try again"
              />
            </div>
          ) : (
            <>
              {error ? (
                <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <form onSubmit={handleSubmit}>
                <FieldGroup className="gap-5">
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
            </>
          )}
        </div>
      </main>
    </div>
  );
}
