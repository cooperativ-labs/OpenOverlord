import { Loader2, LockKeyhole } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  authClient,
  normalizeLocalUsername,
  usernameToLocalEmail,
  validateLocalUsername
} from '@/lib/auth-client';

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
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isCreate = mode === 'create-account';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const usernameError = validateLocalUsername(username);
    if (usernameError) {
      setError(usernameError);
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const normalizedUsername = normalizeLocalUsername(username);
      const email = usernameToLocalEmail(normalizedUsername);
      const result = isCreate
        ? await authClient.signUp.email({
            email,
            password,
            name: normalizedUsername
          })
        : await authClient.signIn.email({ email, password });

      if (result.error) {
        setError(result.error.message ?? 'Authentication failed.');
        return;
      }

      await onAuthenticated();
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-[360px]">
        <div className="mb-5 flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg border bg-card">
            <LockKeyhole className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Overlord</h1>
            <p className="text-sm text-muted-foreground">Sign in to continue.</p>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 rounded-lg border bg-muted p-1">
          <Button
            type="button"
            variant={isCreate ? 'ghost' : 'secondary'}
            size="sm"
            className="h-8"
            onClick={() => {
              setMode('sign-in');
              setError(null);
            }}
          >
            Sign in
          </Button>
          <Button
            type="button"
            variant={isCreate ? 'secondary' : 'ghost'}
            size="sm"
            className="h-8"
            onClick={() => {
              setMode('create-account');
              setError(null);
            }}
          >
            Create
          </Button>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="auth-username">Username</Label>
            <Input
              id="auth-username"
              autoComplete="username"
              value={username}
              onChange={event => setUsername(event.target.value)}
              disabled={isSubmitting}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              autoComplete={isCreate ? 'new-password' : 'current-password'}
              value={password}
              onChange={event => setPassword(event.target.value)}
              disabled={isSubmitting}
            />
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <Button type="submit" className="w-full" size="lg" disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="animate-spin" /> : null}
            {isCreate ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </section>
    </main>
  );
}
