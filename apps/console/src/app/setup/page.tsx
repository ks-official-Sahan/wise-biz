"use client";

import { useQueryClient } from "@tanstack/react-query";
import { uuidv7 } from "@wise-biz/ids";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Alert, Button, Card, SelectField, Stack, TextField } from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { COUNTRIES, browserTimezone } from "@/lib/locale-data.ts";
import { keys } from "@/lib/queries.ts";
import { useSession } from "@/lib/session.ts";

import s from "../(auth)/auth.module.css";

import type { SubmitEvent } from "react";

/** First business for a signed-in user with none yet. The rest of the profile is collected by onboarding. */
export default function SetupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const session = useSession();
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("Main store");
  const [country, setCountry] = useState("LK");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per attempt: a retried submit replays instead of creating a second business.
  const ids = useMemo(() => ({ tenantId: uuidv7(), key: uuidv7() }), []);

  useEffect(() => {
    if (!session.isPending && session.data === null) router.replace("/sign-in?next=/setup");
  }, [session.isPending, session.data, router]);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const c = COUNTRIES.find((x) => x.value === country) ?? COUNTRIES[0];
    if (c === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/tenancy/tenants", {
        idempotencyKey: ids.key,
        body: {
          tenantId: ids.tenantId,
          name: name.trim(),
          branch: {
            name: branch.trim(),
            kind: "store",
            timezone: country === "LK" ? c.timezone : browserTimezone(),
            currency: c.currency,
            taxRegion: c.value,
          },
        },
      });
      // The shell's tenant list is not mounted here, so invalidating would leave its stale empty copy to render
      // first and bounce back to /setup. Drop it so the shell fetches the new business.
      qc.removeQueries({ queryKey: keys.me });
      router.replace("/onboarding");
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof ApiError
          ? (err.problem.detail ?? err.message)
          : "Could not create the business.",
      );
    }
  }

  return (
    <main className={s.shell}>
      <div className={s.panel}>
        <Card>
          <Stack>
            <h1>Set up your business</h1>
            <p className="muted">Two fields now. You can change everything later in Settings.</p>
            {error === null ? null : <Alert tone="danger">{error}</Alert>}
            <form onSubmit={(e) => void submit(e)} className={s.panel}>
              <TextField
                label="Business name"
                required
                maxLength={200}
                autoComplete="organization"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
              <TextField
                label="First branch"
                required
                maxLength={200}
                help="Your shop, café or warehouse. Add more later."
                value={branch}
                onChange={(e) => {
                  setBranch(e.target.value);
                }}
              />
              <SelectField
                label="Country"
                value={country}
                options={COUNTRIES}
                onChange={(e) => {
                  setCountry(e.target.value);
                }}
              />
              <Button type="submit" busy={busy} className={s.full}>
                Create business
              </Button>
            </form>
          </Stack>
        </Card>
      </div>
    </main>
  );
}
