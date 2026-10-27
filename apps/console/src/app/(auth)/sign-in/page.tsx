"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { Alert, Button, Card, Stack, TextField } from "@/components/ui.tsx";
import { loadAuth } from "@/lib/auth-lazy.ts";
import { safeNext } from "@/lib/safe-next.ts";

import s from "../auth.module.css";

import type { SubmitEvent } from "react";

type Step = "password" | "code";

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void loadAuth();
  }, []);
  const [error, setError] = useState<string | null>(null);

  const qc = useQueryClient();
  const done = (): void => {
    // A signed-out session may be cached from an earlier visit; drop it so the shell reads the new one.
    qc.removeQueries({ queryKey: ["me"] });
    router.replace(next);
    router.refresh();
  };

  async function submitPassword(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await (await loadAuth()).signIn.email({ email, password });
    setBusy(false);
    if (res.error) {
      setError(
        res.error.status === 403
          ? "Verify your email first. We sent you a link when you signed up."
          : res.error.status === 429
            ? "Too many attempts. Wait a minute, then try again."
            : "That email and password do not match.",
      );
      return;
    }
    if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true) {
      await (await loadAuth()).twoFactor.sendOtp();
      setStep("code");
      return;
    }
    done();
  }

  async function submitCode(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await (await loadAuth()).twoFactor.verifyOtp({ code: code.trim() });
    setBusy(false);
    if (res.error) {
      setError("That code is wrong or expired. Request a new one below.");
      return;
    }
    done();
  }

  async function passkey(): Promise<void> {
    setError(null);
    const res = await (await loadAuth()).signIn.passkey();
    if (res.error) {
      setError("Passkey sign-in did not complete. Use your email and password instead.");
      return;
    }
    done();
  }

  return (
    <Card>
      <Stack>
        <h1>{step === "password" ? "Sign in" : "Enter your code"}</h1>
        {params.get("verified") === "1" ? (
          <Alert tone="success">Email verified. Sign in to continue.</Alert>
        ) : null}
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {step === "password" ? (
          <form onSubmit={(e) => void submitPassword(e)} className={s.panel} noValidate={false}>
            <TextField
              label="Email"
              type="email"
              autoComplete="username webauthn"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
            <TextField
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
            <Button type="submit" busy={busy} className={s.full}>
              Sign in
            </Button>
            <div className={s.divider}>or</div>
            <Button variant="secondary" className={s.full} onClick={() => void passkey()}>
              Sign in with a passkey
            </Button>
          </form>
        ) : (
          <form onSubmit={(e) => void submitCode(e)} className={s.panel}>
            <p>We emailed a 6-digit code to {email}. It expires in a few minutes.</p>
            <TextField
              label="Code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
              }}
            />
            <Button type="submit" busy={busy} className={s.full}>
              Verify and sign in
            </Button>
            <Button
              variant="ghost"
              onClick={() => void loadAuth().then((a) => a.twoFactor.sendOtp())}
            >
              Send a new code
            </Button>
          </form>
        )}
        <p>
          New here? <Link href="/sign-up">Create a business account</Link>
        </p>
      </Stack>
    </Card>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
