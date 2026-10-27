"use client";

import { useQueryClient } from "@tanstack/react-query";
import { uuidv7 } from "@wise-biz/ids";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
  Card,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { COUNTRIES, CURRENCIES, timezones } from "@/lib/locale-data.ts";
import { keys, useBranches, useOnboarding, useProfile, useRoles } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import type { Branch, Profile } from "@/lib/types.ts";

const STEPS = ["Business", "First branch", "Invite your team", "Finish"] as const;

interface Values {
  name: string;
  country: string;
  currency: string;
  timezone: string;
  taxRegion: string;
  branchName: string;
  cutoff: string;
  invites: { email: string; roleId: string }[];
}

function initial(
  profile: Profile,
  branch: Branch | undefined,
  draft: Record<string, unknown> | null,
): Values {
  const base: Values = {
    name: profile.name,
    country: profile.country ?? "LK",
    currency: profile.currency ?? branch?.currency ?? "LKR",
    timezone: profile.timezone ?? branch?.timezone ?? "Asia/Colombo",
    taxRegion: profile.taxRegion ?? branch?.taxRegion ?? "LK",
    branchName: branch?.name ?? "Main store",
    cutoff: branch?.businessDayCutoff ?? "00:00",
    invites: [],
  };
  return draft === null ? base : { ...base, ...(draft as Partial<Values>) };
}

export default function OnboardingPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const onboarding = useOnboarding(t);
  const profile = useProfile(t);
  const branches = useBranches(t);
  const roles = useRoles(t);
  const [stepState, setStep] = useState<number | null>(null);
  const [edited, setValues] = useState<Values | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstBranch = branches.data?.[0];

  // Seed from the server draft during render; local edits take over once made.
  const draft = onboarding.data?.draft ?? null;
  const values =
    edited ??
    (onboarding.data !== undefined && profile.data !== undefined && branches.data !== undefined
      ? initial(profile.data, firstBranch, draft?.values ?? null)
      : null);
  const step = stepState ?? Math.min(draft?.step ?? 0, STEPS.length - 1);

  // Move focus to the new step title so screen readers announce it.
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const finished = Boolean(onboarding.data?.onboardedAt);
  useEffect(() => {
    if (finished) router.replace("/");
  }, [finished, router]);

  if (finished) return null;
  if (values === null) return <SkeletonRows label="Loading setup" rows={6} />;

  const set = <K extends keyof Values>(k: K, v: Values[K]): void => {
    setValues((prev) => ({ ...(prev ?? values), [k]: v }));
  };

  /** Applies the step for real, then saves the draft position (audited, so only on step change). */
  async function advance(): Promise<void> {
    if (values === null) return;
    setBusy(true);
    setError(null);
    try {
      if (step === 0) {
        await api("PATCH", "/v1/tenancy/business", {
          body: {
            name: values.name,
            country: values.country,
            currency: values.currency,
            timezone: values.timezone,
            taxRegion: values.taxRegion,
          },
        });
      } else if (step === 1 && firstBranch !== undefined) {
        await api("PATCH", `/v1/tenancy/branches/${firstBranch.branchId}`, {
          body: {
            name: values.branchName,
            timezone: values.timezone,
            businessDayCutoff: values.cutoff,
          },
        });
      } else if (step === 2) {
        for (const inv of values.invites.filter((i) => i.email.trim() !== "")) {
          await api("POST", "/v1/tenancy/invites", {
            body: { id: uuidv7(), email: inv.email.trim(), roleIds: [inv.roleId] },
          });
        }
        set("invites", []);
      } else if (step === 3) {
        await api("POST", "/v1/tenancy/onboarding/complete", { body: {} });
        await qc.invalidateQueries({ queryKey: keys.me });
        router.replace("/");
        return;
      }
      const next = step + 1;
      await api("PUT", "/v1/tenancy/onboarding", {
        body: { step: next, values: { ...values, invites: [] } },
      });
      await qc.invalidateQueries({ queryKey: keys.tenant(t) });
      setStep(next);
    } catch (err) {
      setError(
        err instanceof ApiError ? (err.problem.detail ?? err.message) : "Could not save this step.",
      );
    } finally {
      setBusy(false);
    }
  }

  const assignable = (roles.data ?? []).filter((r) => r.name !== "owner");

  return (
    <Stack>
      <div>
        <p className="muted">
          Step {step + 1} of {STEPS.length}
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {STEPS[step]}
        </h1>
      </div>
      <ol
        aria-label="Setup progress"
        style={{ display: "flex", gap: 8, padding: 0, listStyle: "none", margin: 0 }}
      >
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={i === step ? "step" : undefined}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i <= step ? "var(--wb-color-accent)" : "var(--wb-color-border)",
            }}
          >
            <span className="sr-only">
              {label}
              {i < step ? " (done)" : ""}
            </span>
          </li>
        ))}
      </ol>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void advance();
          }}
        >
          <Stack>
            {step === 0 ? (
              <>
                <TextField
                  label="Business name"
                  required
                  value={values.name}
                  onChange={(e) => {
                    set("name", e.target.value);
                  }}
                />
                <SelectField
                  label="Country"
                  value={values.country}
                  options={COUNTRIES}
                  onChange={(e) => {
                    const c = COUNTRIES.find((x) => x.value === e.target.value);
                    set("country", e.target.value);
                    if (c !== undefined) {
                      set("currency", c.currency);
                      set("timezone", c.timezone);
                      set("taxRegion", c.value);
                    }
                  }}
                />
                <SelectField
                  label="Currency"
                  help="Prices and receipts use it. Branches can differ later."
                  value={values.currency}
                  options={CURRENCIES.map((c) => ({ value: c, label: c }))}
                  onChange={(e) => {
                    set("currency", e.target.value);
                  }}
                />
                <SelectField
                  label="Time zone"
                  value={values.timezone}
                  options={timezones().map((z) => ({ value: z, label: z.replace(/_/g, " ") }))}
                  onChange={(e) => {
                    set("timezone", e.target.value);
                  }}
                />
                <TextField
                  label="Tax region"
                  help="Your tax authority region code, for example LK."
                  required
                  maxLength={32}
                  value={values.taxRegion}
                  onChange={(e) => {
                    set("taxRegion", e.target.value);
                  }}
                />
              </>
            ) : null}
            {step === 1 ? (
              <>
                <TextField
                  label="Branch name"
                  required
                  value={values.branchName}
                  onChange={(e) => {
                    set("branchName", e.target.value);
                  }}
                />
                <TextField
                  label="Business day ends at"
                  type="time"
                  help="Late-night sales before this time count toward the previous day."
                  value={values.cutoff}
                  onChange={(e) => {
                    set("cutoff", e.target.value);
                  }}
                />
              </>
            ) : null}
            {step === 2 ? (
              <>
                <p className="muted">
                  Optional. Invited people get an email link that works for 72 hours.
                </p>
                {values.invites.map((inv, i) => (
                  <Row key={i}>
                    <TextField
                      label={`Email ${String(i + 1)}`}
                      type="email"
                      value={inv.email}
                      onChange={(e) => {
                        set(
                          "invites",
                          values.invites.map((x, j) =>
                            j === i ? { ...x, email: e.target.value } : x,
                          ),
                        );
                      }}
                    />
                    <SelectField
                      label="Role"
                      value={inv.roleId}
                      options={assignable.map((r) => ({
                        value: r.roleId,
                        label: r.name.replace(/_/g, " "),
                      }))}
                      onChange={(e) => {
                        set(
                          "invites",
                          values.invites.map((x, j) =>
                            j === i ? { ...x, roleId: e.target.value } : x,
                          ),
                        );
                      }}
                    />
                  </Row>
                ))}
                <div>
                  <Button
                    variant="secondary"
                    disabled={assignable.length === 0}
                    onClick={() => {
                      set("invites", [
                        ...values.invites,
                        { email: "", roleId: assignable[0]?.roleId ?? "" },
                      ]);
                    }}
                  >
                    Add a person
                  </Button>
                </div>
              </>
            ) : null}
            {step === 3 ? (
              <p>
                {values.name} is ready. You can add branches, people and roles any time from
                Settings and People.
              </p>
            ) : null}
            <Row spread>
              <Button
                variant="ghost"
                disabled={step === 0 || busy}
                onClick={() => {
                  setStep(Math.max(0, step - 1));
                }}
              >
                Back
              </Button>
              <Button type="submit" busy={busy}>
                {step === 3
                  ? "Open the console"
                  : step === 2 && values.invites.length === 0
                    ? "Skip for now"
                    : "Continue"}
              </Button>
            </Row>
          </Stack>
        </form>
      </Card>
    </Stack>
  );
}
