"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Alert, Button, Card, Stack } from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { useSession } from "@/lib/session.ts";

import s from "../../(auth)/auth.module.css";

interface InviteParams {
  readonly tenantId: string;
  readonly inviteId: string;
  readonly token: string;
}

const noop = (): (() => void) => () => undefined;

/** Parses "#t=…&i=…&k=…". The link carries them in the fragment, so they never reach a server log. */
function parseInvite(hash: string): InviteParams | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const t = p.get("t");
  const i = p.get("i");
  const k = p.get("k");
  return t !== null && i !== null && k !== null ? { tenantId: t, inviteId: i, token: k } : null;
}

function AcceptInvite() {
  const router = useRouter();
  const session = useSession();
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const hash = useSyncExternalStore(
    noop,
    () => window.location.hash,
    () => "",
  );
  const invite = useRef<InviteParams | null>(null);
  const [state, setState] = useState<"ready" | "busy" | "error">("ready");
  const [error, setError] = useState<string | null>(null);

  // The token must not stay in the URL (history, screenshots, Referer): keep it in memory and strip it now.
  invite.current ??= parseInvite(hash);
  useEffect(() => {
    if (window.location.hash !== "" || window.location.search !== "")
      window.history.replaceState(null, "", "/invite/accept");
  }, []);

  if (!hydrated) return null;
  if (invite.current === null) {
    return <Alert tone="danger">This invite link is incomplete. Ask for a new invite.</Alert>;
  }
  if (!session.isPending && session.data === null) {
    return (
      <Card>
        <Stack>
          <h1>Join the business</h1>
          <p>
            Sign in or create an account with the email address the invite was sent to, then open
            the link again.
          </p>
          <Row>
            <Link href="/sign-in">Sign in</Link> <Link href="/sign-up">Create account</Link>
          </Row>
        </Stack>
      </Card>
    );
  }

  return (
    <Card>
      <Stack>
        <h1>Join the business</h1>
        <p>You were invited to work in a business on wise-biz.</p>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <Button
          busy={state === "busy"}
          className={s.full}
          onClick={() => {
            const inv = invite.current;
            if (inv === null) return;
            setState("busy");
            void api("POST", "/v1/tenancy/invites/accept", { body: inv })
              .then(() => {
                router.replace("/");
              })
              .catch((err: unknown) => {
                setState("error");
                setError(
                  err instanceof ApiError && err.status === 404
                    ? "This invite is not valid for your account. It may have expired, been revoked, or been sent to another email."
                    : "Could not accept the invite. Try again.",
                );
              });
          }}
        >
          Accept invite
        </Button>
      </Stack>
    </Card>
  );
}

function Row({ children }: { readonly children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 16 }}>{children}</div>;
}

export default function InviteAcceptPage() {
  return (
    <main className={s.shell}>
      <div className={s.panel}>
        <Suspense>
          <AcceptInvite />
        </Suspense>
      </div>
    </main>
  );
}
