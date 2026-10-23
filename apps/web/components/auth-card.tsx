'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { apiRequest } from '../lib/api';
import { ThemeToggle } from './theme-provider';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function AuthCard({ mode }: { mode: 'setup' | 'login' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const setup = mode === 'setup';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      await apiRequest(setup ? '/setup/owner' : '/auth/login', {
        method: 'POST',
        headers: setup ? { 'x-setup-token': setupToken } : undefined,
        body: JSON.stringify({ email, password }),
      });
      router.replace(setup ? '/login' : '/');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-md">
        <div className="relative mb-8 flex flex-col items-center text-center">
          <div>
            <Image
              alt="Indexlume"
              className="mx-auto h-24 w-72 object-cover object-center"
              height={2000}
              priority
              src="/brand/indexlume-logo.svg"
              unoptimized
              width={2000}
            />
            <p className="text-xs text-muted-foreground">
              Built for developers. Designed for simplicity. Ready to scale.
            </p>
          </div>
          <div className="absolute right-0 top-0">
            <ThemeToggle />
          </div>
        </div>
        <section className="rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl sm:p-8">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {setup ? 'First-run setup' : 'Secure access'}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {setup ? 'Create the owner account' : 'Sign in'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {setup
              ? 'This one-time screen is protected by the setup token. The password must contain at least 12 characters.'
              : 'Use an account created by the workspace owner. Public sign-up is disabled.'}
          </p>

          <form className="mt-7 space-y-5" onSubmit={submit}>
            <Field
              label="Email"
              type="email"
              value={email}
              onChange={setEmail}
              autoComplete="email"
            />
            <Field
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete={setup ? 'new-password' : 'current-password'}
              minLength={12}
            />
            {setup ? (
              <Field
                label="Setup token"
                type="password"
                value={setupToken}
                onChange={setSetupToken}
                autoComplete="off"
              />
            ) : null}
            {error ? <Alert variant="destructive">{error}</Alert> : null}
            <Button className="h-10 w-full" disabled={pending} type="submit">
              {pending
                ? 'Please wait…'
                : setup
                  ? 'Create owner account'
                  : 'Sign in'}
            </Button>
          </form>
          {!setup ? (
            <p className="mt-5 text-center text-xs text-muted-foreground">
              Need the initial owner account?{' '}
              <Link className="text-foreground underline" href="/setup">
                Check setup
              </Link>
            </p>
          ) : null}
        </section>
        <footer className="mt-6 text-center text-xs leading-5 text-muted-foreground">
          © 2026 Oryxsol · Indexlume original code is licensed under Apache-2.0.
          Third-party components retain their own licenses.
        </footer>
      </div>
    </main>
  );
}

function Field({
  label,
  onChange,
  ...props
}: {
  label: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'>) {
  return (
    <label className="block text-sm font-medium text-foreground">
      {label}
      <Input
        {...props}
        required
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-10"
      />
    </label>
  );
}
