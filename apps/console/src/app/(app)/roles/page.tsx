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
  ErrorState,
  Row,
  SkeletonRows,
  Stack,
  TextField,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { PERMISSION_GROUPS, diffGrants } from "@/lib/permissions.ts";
import { keys, useApiMutation, useRoles } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import type { Role } from "@/lib/types.ts";

const label = (name: string): string => name.replace(/_/g, " ");

function RoleEditor({ role }: { role: Role }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const saved = useMemo(() => new Set(role.grants.map((g) => g.permission)), [role]);
  const [draft, setDraft] = useState<Set<string>>(() => new Set(saved));
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const diff = diffGrants(saved, draft);
  const changed = diff.added.length + diff.removed.length > 0;
  const save = useApiMutation(
    () =>
      api("PUT", `/v1/tenancy/roles/${role.roleId}/permissions`, {
        body: { grants: [...draft].map((permission) => ({ permission })) },
      }),
    [keys.roles(t)],
  );
  const locked = role.implicitAll;

  return (
    <Card>
      <Stack>
        <Row spread>
          <h2>{label(role.name)}</h2>
          {role.implicitAll ? (
            <Badge tone="accent">Everything, always</Badge>
          ) : role.isSystem ? (
            <Badge>Built-in</Badge>
          ) : (
            <Badge>Custom</Badge>
          )}
        </Row>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {PERMISSION_GROUPS.map((g) => (
          <fieldset
            key={g.module}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 4 }}
          >
            <legend style={{ fontWeight: 600, marginBottom: 8 }}>{g.module}</legend>
            {g.items.map((p) => (
              <label
                key={p.permission}
                style={{
                  display: "grid",
                  gridTemplateColumns: "24px 1fr",
                  gap: 12,
                  alignItems: "start",
                  minHeight: 44,
                  paddingBlock: 6,
                }}
              >
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={locked || draft.has(p.permission)}
                  onChange={(e) => {
                    const next = new Set(draft);
                    if (e.target.checked) next.add(p.permission);
                    else next.delete(p.permission);
                    setDraft(next);
                    setReview(false);
                  }}
                  style={{ marginTop: 4 }}
                />
                <span>
                  <strong>{p.label}</strong>
                  <br />
                  <span className="muted">{p.allows}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ))}
        {locked ? (
          <p className="muted">The owner role holds every permission and cannot be changed.</p>
        ) : (
          <>
            {review && changed ? (
              <Alert tone="info">
                {diff.added.length > 0 ? `Allows: ${diff.added.join(", ")}. ` : ""}
                {diff.removed.length > 0 ? `Stops allowing: ${diff.removed.join(", ")}. ` : ""}
                Everyone with this role is affected on their next request.
              </Alert>
            ) : null}
            <Row>
              <Button
                disabled={!changed}
                busy={save.isPending}
                onClick={() => {
                  if (!review) {
                    setReview(true);
                    return;
                  }
                  save.mutate(undefined, {
                    onSuccess: () => {
                      setReview(false);
                    },
                    onError: (err) => {
                      setError(
                        err instanceof ApiError && err.status === 404
                          ? "Only owners can change roles."
                          : "Could not save the role.",
                      );
                    },
                  });
                }}
              >
                {review ? "Confirm and save" : "Review changes"}
              </Button>
              {changed ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDraft(new Set(saved));
                    setReview(false);
                  }}
                >
                  Discard
                </Button>
              ) : null}
            </Row>
          </>
        )}
      </Stack>
    </Card>
  );
}

function NewRoleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState(uuidv7);
  const create = useApiMutation(
    () =>
      api("POST", "/v1/tenancy/roles", {
        idempotencyKey: id,
        body: { id, name: name.trim().toLowerCase().replace(/\s+/g, "_") },
      }),
    [keys.roles(t)],
  );
  return (
    <Dialog open={open} title="Create a role" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined, {
            onSuccess: () => {
              setName("");
              setId(uuidv7());
              onClose();
            },
            onError: (err) => {
              setError(
                err instanceof ApiError && err.status === 409
                  ? "A role with that name exists."
                  : err instanceof ApiError && err.status === 404
                    ? "Only owners can create roles."
                    : "Use lowercase letters, digits and spaces.",
              );
            },
          });
        }}
      >
        <Stack>
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <TextField
            label="Role name"
            required
            maxLength={63}
            help="For example: shift lead"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Row spread>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={create.isPending}>
              Create role
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}

function RolesView() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant } = useTenant();
  const roles = useRoles(tenant.tenantId);
  return (
    <Stack>
      <Row spread>
        <h1>Roles</h1>
        <Button
          onClick={() => {
            router.replace("/roles?new=1");
          }}
        >
          Create a role
        </Button>
      </Row>
      <p className="muted">A role is a set of permissions. People can hold several roles.</p>
      {roles.isPending ? (
        <SkeletonRows label="Loading roles" />
      ) : roles.isError ? (
        <ErrorState error={roles.error} onRetry={() => void roles.refetch()} />
      ) : (
        roles.data.map((r) => (
          <RoleEditor key={`${r.roleId}:${String(r.grants.length)}`} role={r} />
        ))
      )}
      <NewRoleDialog
        open={params.get("new") === "1"}
        onClose={() => {
          router.replace("/roles");
        }}
      />
    </Stack>
  );
}

export default function RolesPage() {
  return (
    <Suspense>
      <RolesView />
    </Suspense>
  );
}
