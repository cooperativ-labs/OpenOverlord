import { type FormEvent, useEffect, useState } from 'react';

import { BackendLoginPanel } from '@/components/auth/BackendLoginPanel';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { type ButtonLoadingState, LoadingButton } from '@/components/ui/loading-button';
import { Separator } from '@/components/ui/separator';
import { api } from '@/lib/api';
import {
  getAuthBaseUrl,
  isDesktopRemoteBackend,
  isRemoteBackend,
  persistAuthSessionFromSignInResult
} from '@/lib/api-base';
import {
  authClient,
  normalizeEmail,
  socialSignInFetchOptions,
  validateEmail
} from '@/lib/auth-client';

type AuthMode = 'sign-in' | 'create-account';

type AuthScreenProps = {
  onAuthenticated: () => Promise<void> | void;
};

const AUTH_MODE_SEARCH_PARAM = 'mode';

/** GitHub wordmark glyph — lucide dropped brand icons, so inline the SVG. */
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .5C5.73.5.5 5.73.5 12.01c0 5.02 3.26 9.28 7.78 10.79.57.1.78-.25.78-.55 0-.27-.01-.98-.02-1.92-3.17.69-3.84-1.53-3.84-1.53-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.75 2.68 1.24 3.33.95.1-.74.4-1.24.72-1.53-2.53-.29-5.19-1.27-5.19-5.64 0-1.25.44-2.27 1.18-3.07-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.15 1.17.91-.25 1.89-.38 2.86-.38.97 0 1.95.13 2.86.38 2.19-1.48 3.15-1.17 3.15-1.17.62 1.57.23 2.73.11 3.02.74.8 1.18 1.82 1.18 3.07 0 4.38-2.67 5.35-5.21 5.63.41.35.78 1.05.78 2.12 0 1.53-.01 2.76-.01 3.14 0 .31.2.66.79.55A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

function authErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message?: unknown }).message ?? '').trim();
    if (message) return message;
  }
  return 'Authentication failed.';
}

function parseAuthModeFromSearch(search: string): AuthMode {
  const params = new URLSearchParams(search);
  const rawMode = params.get(AUTH_MODE_SEARCH_PARAM)?.trim().toLowerCase();
  if (
    rawMode === 'create-account' ||
    rawMode === 'create' ||
    rawMode === 'sign-up' ||
    rawMode === 'signup'
  ) {
    return 'create-account';
  }
  return 'sign-in';
}

function syncAuthModeSearchParam(mode: AuthMode) {
  const url = new URL(window.location.href);
  url.searchParams.set(AUTH_MODE_SEARCH_PARAM, mode);
  window.history.replaceState(window.history.state, '', url);
}

function socialSignInCallbackError(code: string): string {
  if (code === 'account_not_linked') {
    return 'This email already has an Overlord account. Sign in with your email and password, verify the email if prompted, then try GitHub again.';
  }
  return 'GitHub sign-in could not be completed. Try again.';
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(() =>
    typeof window === 'undefined' ? 'sign-in' : parseAuthModeFromSearch(window.location.search)
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitButtonState, setSubmitButtonState] = useState<ButtonLoadingState>('default');
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [resendButtonState, setResendButtonState] = useState<ButtonLoadingState>('default');
  const [otpCode, setOtpCode] = useState('');
  const [verifyButtonState, setVerifyButtonState] = useState<ButtonLoadingState>('default');
  const [githubEnabled, setGithubEnabled] = useState(false);
  const [githubPending, setGithubPending] = useState(false);

  const isCreate = mode === 'create-account';
  // The backend chooser only exists in the desktop shell (Electron preload bridge).
  // In the browser/cloud build there is no bridge, so we skip the backend section and
  // its separator instead of rendering an empty inset box.
  const hasBackendChooser =
    typeof window !== 'undefined' && Boolean(window.overlord?.switchBackend);

  useEffect(() => {
    syncAuthModeSearchParam(mode);
  }, [mode]);

  useEffect(() => {
    const callbackUrl = new URL(window.location.href);
    const socialError = callbackUrl.searchParams.get('error');
    if (!socialError) return;

    setError(socialSignInCallbackError(socialError));
    callbackUrl.searchParams.delete('error');
    window.history.replaceState(
      null,
      '',
      `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`
    );
  }, []);

  useEffect(() => {
    function handlePopState() {
      setMode(parseAuthModeFromSearch(window.location.search));
    }

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  // Ask the backend (pre-auth, public endpoint) whether GitHub login is
  // configured. Remote desktop OAuth is completed by Electron's one-time
  // deep-link handoff, while hosted browsers keep their normal redirect.
  useEffect(() => {
    let cancelled = false;
    api
      .authProviders()
      .then(providers => {
        if (cancelled) return;
        setGithubEnabled(providers.github);
      })
      .catch(() => {
        /* Provider probe is best-effort; fall back to email-only on failure. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleGitHubSignIn() {
    setError(null);
    setGithubPending(true);
    try {
      const desktopRemote = isDesktopRemoteBackend();
      if (desktopRemote) {
        if (!window.overlord?.openExternal) {
          throw new Error('Unable to open GitHub sign-in in your default browser.');
        }
        const opened = await window.overlord.openExternal(
          `${getAuthBaseUrl()}/api/auth/desktop/github`
        );
        if (!opened) throw new Error('Unable to open GitHub sign-in in your default browser.');
        return;
      }

      const callbackURL = isRemoteBackend()
        ? new URL('/api/auth/browser/callback', getAuthBaseUrl())
        : new URL(window.location.origin);
      if (isRemoteBackend()) callbackURL.searchParams.set('returnTo', window.location.origin);
      const result = await authClient.signIn.social({
        provider: 'github',
        callbackURL: callbackURL.toString(),
        errorCallbackURL: window.location.origin,
        // Better Auth persists the OAuth state in a cookie before redirecting
        // to GitHub. This must override the remote client's usual
        // credentials: 'omit' policy for this one bootstrap request.
        fetchOptions: socialSignInFetchOptions()
      });
      if (result.error) {
        setError(result.error.message ?? 'GitHub sign-in failed.');
        setGithubPending(false);
        return;
      }
      // On success the browser navigates away; leave the spinner up.
    } catch (err) {
      setError(authErrorMessage(err));
      setGithubPending(false);
    }
  }

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

  async function handleVerifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingVerificationEmail) return;
    const code = otpCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the 6-digit code from your email.');
      setVerifyButtonState('error');
      return;
    }

    setError(null);
    setVerifyButtonState('loading');
    try {
      const result = await authClient.emailOtp.verifyEmail({
        email: pendingVerificationEmail,
        otp: code
      });
      if (result.error) {
        setError(result.error.message ?? 'That code is invalid or expired.');
        setVerifyButtonState('error');
        return;
      }

      // With autoSignInAfterVerification, a successful verify returns a session
      // token; enter the app exactly like a password sign-in.
      if (!result.data?.token) {
        setError('Verified, but sign-in did not complete. Try signing in.');
        setVerifyButtonState('error');
        return;
      }

      setVerifyButtonState('success');
      await persistAuthSessionFromSignInResult(result.data);
      await onAuthenticated();
    } catch (err) {
      setError(authErrorMessage(err));
      setVerifyButtonState('error');
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
    setOtpCode('');
    setVerifyButtonState('default');
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
            <div className="flex flex-col gap-4">
              <p className="text-center text-sm text-muted-foreground">
                We sent a verification email to <strong>{pendingVerificationEmail}</strong>. Follow
                the link, or enter the 6-digit code below to finish signing in.
              </p>

              {error ? (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <form onSubmit={handleVerifyOtp}>
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="auth-otp">Verification code</FieldLabel>
                    <Input
                      id="auth-otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      maxLength={6}
                      placeholder="000000"
                      className="text-center tracking-[0.5em]"
                      value={otpCode}
                      onChange={event =>
                        setOtpCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                      }
                      disabled={verifyButtonState === 'loading'}
                      autoFocus
                    />
                  </Field>
                  <Field>
                    <LoadingButton
                      type="submit"
                      className="w-full"
                      buttonState={verifyButtonState}
                      setButtonState={setVerifyButtonState}
                      text="Verify code"
                      loadingText="Verifying..."
                      successText="Verified"
                      errorText="Verification failed"
                    />
                  </Field>
                </FieldGroup>
              </form>

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
              {githubEnabled ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={handleGitHubSignIn}
                    disabled={githubPending || submitButtonState === 'loading'}
                  >
                    <GitHubIcon className="size-4" />
                    {githubPending ? 'Redirecting to GitHub…' : 'Continue with GitHub'}
                  </Button>
                  <div className="my-5 flex items-center gap-3">
                    <Separator className="flex-1" />
                    <span className="text-xs text-muted-foreground">or continue with email</span>
                    <Separator className="flex-1" />
                  </div>
                </>
              ) : null}

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
