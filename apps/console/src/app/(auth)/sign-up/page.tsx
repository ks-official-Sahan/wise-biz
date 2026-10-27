"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Alert, Button, Card, Stack, TextField } from "@/components/ui.tsx";
import { loadAuth } from "@/lib/auth-lazy.ts";

import s from "../auth.module.css";

import type { SubmitEvent } from "react";

/** Same rule as modules/identity password-policy (12+ characters); the API enforces the full policy. */
const MIN_PASSWORD = 12;

export default function SignUpPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadAuth();
  }, []);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const short = password.length > 0 && password.length < MIN_PASSWORD;

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (password.length < MIN_PASSWORD) return;
    setBusy(true);
    setError(null);
    const res = await (
      await loadAuth()
    ).signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
      callbackURL: "/sign-in?verified=1",
    });
    setBusy(false);
    if (res.error) {
      setError(
        res.error.status === 429
          ? "Too many sign-ups from this network. Try again later."
          : (res.error.message ?? "Sign-up failed. Check the fields and try again."),
      );
      return;
    }
    // Uniform response (security.md): the same message whether or not the email already had an account.
    setSent(true);
  }

  if (sent) {
    return (
      <Card>
        <Stack>
          <h1>Check your email</h1>
          <p>
            We sent a verification link to <strong>{email}</strong>. Open it on this device to
            finish, then sign in.
          </p>
          <Link href="/sign-in">Back to sign in</Link>
        </Stack>
      </Card>
    );
  }

  return (
    <Card>
      <Stack>
        <h1>Create your account</h1>
        <p className="muted">You set up your business right after this.</p>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <form onSubmit={(e) => void submit(e)} className={s.panel}>
          <TextField
            label="Your name"
            autoComplete="name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD}
            help={`At least ${String(MIN_PASSWORD)} characters. A short sentence works well.`}
            error={short ? `Use at least ${String(MIN_PASSWORD)} characters.` : undefined}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          <Button type="submit" busy={busy} className={s.full}>
            Create account
          </Button>
        </form>
        <p>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </Stack>
    </Card>
  );
}
