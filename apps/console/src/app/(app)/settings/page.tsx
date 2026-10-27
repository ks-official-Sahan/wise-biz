"use client";

import { uuidv7 } from "@wise-biz/ids";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  ErrorState,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { COUNTRIES, CURRENCIES, timezones } from "@/lib/locale-data.ts";
import { keys, useApiMutation, useBranches, useLocations, useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import type { Branch, BranchKind, LocationKind, Profile } from "@/lib/types.ts";

const TABS = [
  { key: "business", label: "Business" },
  { key: "branches", label: "Branches" },
] as const;

const errorText = (err: unknown, fallback: string): string =>
  err instanceof ApiError
    ? err.status === 404
      ? "You do not have permission to change this."
      : (err.problem.errors?.[0]?.message ?? err.problem.detail ?? fallback)
    : fallback;

function ProfileForm({ profile }: { profile: Profile }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [v, setV] = useState({
    name: profile.name,
    country: profile.country ?? "LK",
    currency: profile.currency ?? "LKR",
    timezone: profile.timezone ?? "Asia/Colombo",
    taxRegion: profile.taxRegion ?? "",
  });
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const save = useApiMutation(
    () => api("PATCH", "/v1/tenancy/business", { body: v }),
    [keys.profile(t), keys.myTenants],
  );
  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, {
            onSuccess: () => {
              setMsg({ tone: "success", text: "Saved." });
            },
            onError: (err) => {
              setMsg({ tone: "danger", text: errorText(err, "Could not save.") });
            },
          });
        }}
      >
        <Stack>
          <h2>Business profile</h2>
          {msg === null ? null : <Alert tone={msg.tone}>{msg.text}</Alert>}
          <TextField
            label="Business name"
            required
            value={v.name}
            onChange={(e) => {
              setV({ ...v, name: e.target.value });
            }}
          />
          <SelectField
            label="Country"
            value={v.country}
            options={COUNTRIES}
            onChange={(e) => {
              setV({ ...v, country: e.target.value });
            }}
          />
          <SelectField
            label="Currency"
            value={v.currency}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            onChange={(e) => {
              setV({ ...v, currency: e.target.value });
            }}
          />
          <SelectField
            label="Time zone"
            value={v.timezone}
            options={timezones().map((z) => ({ value: z, label: z.replace(/_/g, " ") }))}
            onChange={(e) => {
              setV({ ...v, timezone: e.target.value });
            }}
          />
          <TextField
            label="Tax region"
            maxLength={32}
            value={v.taxRegion}
            onChange={(e) => {
              setV({ ...v, taxRegion: e.target.value });
            }}
          />
          <div>
            <Button type="submit" busy={save.isPending}>
              Save profile
            </Button>
          </div>
        </Stack>
      </form>
    </Card>
  );
}

const BRANCH_KINDS: readonly { value: BranchKind; label: string }[] = [
  { value: "store", label: "Store" },
  { value: "warehouse", label: "Warehouse" },
  { value: "office", label: "Office" },
];

function BranchDialog({
  open,
  branch,
  onClose,
}: {
  open: boolean;
  branch: Branch | null;
  onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const profile = useProfile(t);
  const id = useMemo(() => uuidv7(), []);
  const [v, setV] = useState(() => ({
    name: branch?.name ?? "",
    kind: branch?.kind ?? "store",
    timezone: branch?.timezone ?? profile.data?.timezone ?? "Asia/Colombo",
    currency: branch?.currency ?? profile.data?.currency ?? "LKR",
    taxRegion: branch?.taxRegion ?? profile.data?.taxRegion ?? "LK",
    businessDayCutoff: branch?.businessDayCutoff ?? "00:00",
  }));
  const [error, setError] = useState<string | null>(null);
  const save = useApiMutation(
    () =>
      branch === null
        ? api("POST", "/v1/tenancy/branches", { idempotencyKey: id, body: { id, ...v } })
        : api("PATCH", `/v1/tenancy/branches/${branch.branchId}`, { body: v }),
    [keys.branches(t)],
  );
  return (
    <Dialog
      open={open}
      title={branch === null ? "Add a branch" : `Edit ${branch.name}`}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(undefined, {
            onSuccess: onClose,
            onError: (err) => {
              setError(errorText(err, "Could not save the branch."));
            },
          });
        }}
      >
        <Stack>
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <TextField
            label="Name"
            required
            value={v.name}
            onChange={(e) => {
              setV({ ...v, name: e.target.value });
            }}
          />
          <SelectField
            label="Kind"
            value={v.kind}
            options={BRANCH_KINDS}
            onChange={(e) => {
              setV({ ...v, kind: e.target.value as BranchKind });
            }}
          />
          <SelectField
            label="Time zone"
            value={v.timezone}
            options={timezones().map((z) => ({ value: z, label: z.replace(/_/g, " ") }))}
            onChange={(e) => {
              setV({ ...v, timezone: e.target.value });
            }}
          />
          <SelectField
            label="Currency"
            value={v.currency}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            onChange={(e) => {
              setV({ ...v, currency: e.target.value });
            }}
          />
          <TextField
            label="Tax region"
            required
            maxLength={32}
            value={v.taxRegion}
            onChange={(e) => {
              setV({ ...v, taxRegion: e.target.value });
            }}
          />
          <TextField
            label="Business day ends at"
            type="time"
            value={v.businessDayCutoff}
            onChange={(e) => {
              setV({ ...v, businessDayCutoff: e.target.value });
            }}
          />
          <Row spread>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={save.isPending}>
              {branch === null ? "Add branch" : "Save branch"}
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}

const LOCATION_KINDS: readonly { value: LocationKind; label: string }[] = [
  { value: "sales_floor", label: "Sales floor" },
  { value: "backroom", label: "Back room" },
  { value: "warehouse", label: "Warehouse" },
];

function Locations({ branch }: { branch: Branch }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const locations = useLocations(t, branch.branchId);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LocationKind>("backroom");
  const [error, setError] = useState<string | null>(null);
  const add = useApiMutation(
    () =>
      api("POST", `/v1/tenancy/branches/${branch.branchId}/locations`, {
        body: { id: uuidv7(), name: name.trim(), kind },
      }),
    [keys.locations(t, branch.branchId)],
  );
  const archive = useApiMutation(
    (input: { id: string; archived: boolean }) =>
      api("PATCH", `/v1/tenancy/locations/${input.id}`, { body: { archived: input.archived } }),
    [keys.locations(t, branch.branchId)],
  );
  return (
    <Stack>
      <h3>Stock locations</h3>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      {locations.isPending ? (
        <SkeletonRows rows={2} label="Loading locations" />
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
          {(locations.data ?? []).map((l) => (
            <li key={l.locationId}>
              <Row spread>
                <span>
                  {l.name}{" "}
                  <span className="muted">
                    · {LOCATION_KINDS.find((k) => k.value === l.kind)?.label}
                  </span>{" "}
                  {l.archived ? <Badge tone="warning">Archived</Badge> : null}
                </span>
                <Button
                  variant="ghost"
                  onClick={() => {
                    archive.mutate({ id: l.locationId, archived: !l.archived });
                  }}
                >
                  {l.archived ? "Restore" : "Archive"}
                </Button>
              </Row>
            </li>
          ))}
        </ul>
      )}
      {branch.archived ? null : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate(undefined, {
              onSuccess: () => {
                setName("");
                setError(null);
              },
              onError: (err) => {
                setError(errorText(err, "Could not add the location."));
              },
            });
          }}
        >
          <Row>
            <TextField
              label="New location"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
            <SelectField
              label="Kind"
              value={kind}
              options={LOCATION_KINDS}
              onChange={(e) => {
                setKind(e.target.value as LocationKind);
              }}
            />
            <Button type="submit" variant="secondary" busy={add.isPending}>
              Add location
            </Button>
          </Row>
        </form>
      )}
    </Stack>
  );
}

function Branches() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const [editing, setEditing] = useState<Branch | null>(null);
  const archive = useApiMutation(
    (b: Branch) =>
      api("PATCH", `/v1/tenancy/branches/${b.branchId}`, { body: { archived: !b.archived } }),
    [keys.branches(t)],
  );
  const creating = params.get("new") === "1";
  return (
    <Stack>
      <Row spread>
        <h2>Branches</h2>
        <Button
          onClick={() => {
            router.replace("/settings?tab=branches&new=1");
          }}
        >
          Add a branch
        </Button>
      </Row>
      {branches.isPending ? (
        <SkeletonRows label="Loading branches" />
      ) : branches.isError ? (
        <ErrorState error={branches.error} onRetry={() => void branches.refetch()} />
      ) : branches.data.length === 0 ? (
        <Empty title="No branches">Add the place where you sell.</Empty>
      ) : (
        branches.data.map((b) => (
          <Card key={b.branchId}>
            <Stack>
              <Row spread>
                <div>
                  <h3>
                    {b.name} {b.archived ? <Badge tone="warning">Archived</Badge> : null}
                  </h3>
                  <p className="muted">
                    {b.kind} · {b.currency} · {b.timezone.replace(/_/g, " ")} · day ends{" "}
                    {b.businessDayCutoff}
                  </p>
                </div>
                <Row>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditing(b);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      archive.mutate(b);
                    }}
                  >
                    {b.archived ? "Restore" : "Archive"}
                  </Button>
                </Row>
              </Row>
              <Locations branch={b} />
            </Stack>
          </Card>
        ))
      )}
      {creating ? (
        <BranchDialog
          open
          branch={null}
          onClose={() => {
            router.replace("/settings?tab=branches");
          }}
        />
      ) : null}
      {editing === null ? null : (
        <BranchDialog
          key={editing.branchId}
          open
          branch={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}

function SettingsView() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant } = useTenant();
  const profile = useProfile(tenant.tenantId);
  const tab = params.get("tab") === "branches" ? "branches" : "business";
  return (
    <Stack>
      <h1>Settings</h1>
      <div
        role="tablist"
        aria-label="Settings sections"
        className={styles.row}
        onKeyDown={(e) => {
          // Roving tabindex: arrows, Home and End move between tabs (WAI-ARIA tabs pattern).
          const i = TABS.findIndex((x) => x.key === tab);
          const next =
            e.key === "ArrowRight"
              ? (i + 1) % TABS.length
              : e.key === "ArrowLeft"
                ? (i - 1 + TABS.length) % TABS.length
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? TABS.length - 1
                    : null;
          const target = next === null ? undefined : TABS[next];
          if (target === undefined) return;
          e.preventDefault();
          router.replace(`/settings?tab=${target.key}` as never);
          e.currentTarget.querySelectorAll<HTMLElement>("[role=tab]")[next ?? 0]?.focus();
        }}
      >
        {TABS.map((x) => (
          <Button
            key={x.key}
            role="tab"
            aria-selected={tab === x.key}
            tabIndex={tab === x.key ? 0 : -1}
            variant={tab === x.key ? "secondary" : "ghost"}
            onClick={() => {
              router.replace(`/settings?tab=${x.key}` as never);
            }}
          >
            {x.label}
          </Button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tab === "branches" ? "Branches" : "Business"}>
        {tab === "branches" ? (
          <Branches />
        ) : profile.isPending ? (
          <SkeletonRows label="Loading profile" />
        ) : profile.isError ? (
          <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
        ) : (
          <ProfileForm key={tenant.tenantId} profile={profile.data} />
        )}
      </div>
    </Stack>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsView />
    </Suspense>
  );
}
