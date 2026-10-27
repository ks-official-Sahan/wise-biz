"use client";

import { uuidv7 } from "@wise-biz/ids";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
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
import {
  keys,
  useApiMutation,
  useBranches,
  useInvites,
  useMembers,
  useRoles,
} from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import type { Member, Role } from "@/lib/types.ts";
import type { SubmitEvent } from "react";

const label = (name: string): string => name.replace(/_/g, " ");

function InviteDialog({
  open,
  onClose,
  roles,
}: {
  open: boolean;
  onClose: () => void;
  roles: readonly Role[];
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const assignable = roles.filter((r) => r.name !== "owner");
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(assignable[0]?.roleId ?? "");
  const [branchId, setBranchId] = useState("all");
  const [error, setError] = useState<string | null>(null);
  // One key per invite: retries of a submit reuse it, a new invite gets a fresh one.
  const [id, setId] = useState(uuidv7);
  const chosenRole = roleId === "" ? (assignable[0]?.roleId ?? "") : roleId;
  const invite = useApiMutation(
    () =>
      api("POST", "/v1/tenancy/invites", {
        idempotencyKey: id,
        body: {
          id,
          email: email.trim(),
          roleIds: [chosenRole],
          branchIds: branchId === "all" ? null : [branchId],
        },
      }),
    [keys.invites(t)],
  );

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await invite.mutateAsync(undefined);
      setEmail("");
      setId(uuidv7());
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (err.fieldError("email") ?? err.problem.detail ?? err.message)
          : "Invite failed.",
      );
    }
  }

  return (
    <Dialog open={open} title="Invite a person" onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <Stack>
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <TextField
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
          <SelectField
            label="Role"
            value={chosenRole}
            options={assignable.map((r) => ({ value: r.roleId, label: label(r.name) }))}
            onChange={(e) => {
              setRoleId(e.target.value);
            }}
          />
          <SelectField
            label="Branches"
            help="Limit this person to one branch, or allow every branch."
            value={branchId}
            options={[
              { value: "all", label: "All branches" },
              ...(branches.data ?? [])
                .filter((b) => !b.archived)
                .map((b) => ({ value: b.branchId, label: b.name })),
            ]}
            onChange={(e) => {
              setBranchId(e.target.value);
            }}
          />
          <Row spread>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={invite.isPending}>
              Send invite
            </Button>
          </Row>
        </Stack>
      </form>
    </Dialog>
  );
}

function RolesDialog({
  member,
  roles,
  onClose,
}: {
  member: Member | null;
  roles: readonly Role[];
  onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useMemo(
    () => new Set(roles.filter((r) => member?.roles.includes(r.name)).map((r) => r.roleId)),
    [member, roles],
  );
  const [initialised, setInitialised] = useState<string | null>(null);
  if (member !== null && initialised !== member.membershipId) {
    setInitialised(member.membershipId);
    setSelected(new Set(current));
    setConfirm(false);
    setError(null);
  }
  const save = useApiMutation(
    () =>
      api("PUT", `/v1/tenancy/members/${member?.membershipId ?? ""}/roles`, {
        body: { roleIds: [...selected] },
      }),
    [keys.members(t)],
  );
  const added = roles.filter((r) => selected.has(r.roleId) && !current.has(r.roleId));
  const removed = roles.filter((r) => !selected.has(r.roleId) && current.has(r.roleId));

  return (
    <Dialog open={member !== null} title="Change roles" onClose={onClose}>
      <Stack>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
          <legend className="sr-only">Roles</legend>
          {roles.map((r) => (
            <label
              key={r.roleId}
              style={{ display: "flex", gap: 12, alignItems: "center", minHeight: 44 }}
            >
              <input
                type="checkbox"
                checked={selected.has(r.roleId)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(r.roleId);
                  else next.delete(r.roleId);
                  setSelected(next);
                  setConfirm(false);
                }}
              />
              {label(r.name)}
            </label>
          ))}
        </fieldset>
        {confirm ? (
          <Alert tone="info">
            {added.length > 0 ? `Adds ${added.map((r) => label(r.name)).join(", ")}. ` : ""}
            {removed.length > 0 ? `Removes ${removed.map((r) => label(r.name)).join(", ")}. ` : ""}
            Takes effect on their next request.
          </Alert>
        ) : null}
        <Row spread>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            busy={save.isPending}
            disabled={selected.size === 0 || (added.length === 0 && removed.length === 0)}
            onClick={() => {
              if (!confirm) {
                setConfirm(true);
                return;
              }
              save.mutate(undefined, {
                onSuccess: onClose,
                onError: (err) => {
                  setError(
                    err instanceof ApiError
                      ? (err.problem.detail ?? err.message)
                      : "Could not save.",
                  );
                },
              });
            }}
          >
            {confirm ? "Confirm change" : "Review change"}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

function PeopleView() {
  const router = useRouter();
  const params = useSearchParams();
  const { tenant, userId } = useTenant();
  const t = tenant.tenantId;
  const members = useMembers(t);
  const invites = useInvites(t);
  const roles = useRoles(t);
  const [editing, setEditing] = useState<Member | null>(null);
  const inviteOpen = params.get("invite") === "1";
  const rows = members.data?.pages.flatMap((p) => p.members) ?? [];

  return (
    <Stack>
      <Row spread>
        <h1>People</h1>
        <Button
          onClick={() => {
            router.replace("/people?invite=1");
          }}
        >
          Invite a person
        </Button>
      </Row>
      {members.isPending ? (
        <SkeletonRows label="Loading people" />
      ) : members.isError ? (
        <ErrorState error={members.error} onRetry={() => void members.refetch()} />
      ) : rows.length === 0 ? (
        <Empty
          title="No people yet"
          action={
            <Button
              onClick={() => {
                router.replace("/people?invite=1");
              }}
            >
              Invite a person
            </Button>
          }
        >
          Invite your staff so they can sign in and sell.
        </Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Members of {tenant.name}</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Roles</th>
                <th scope="col">Branches</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.membershipId}>
                  <td className="num">
                    {m.userId === userId ? "You" : `${m.userId.slice(0, 8)}…`}
                  </td>
                  <td>
                    <Row>
                      {m.roles.map((r) => (
                        <Badge key={r} tone={r === "owner" ? "accent" : "neutral"}>
                          {label(r)}
                        </Badge>
                      ))}
                    </Row>
                  </td>
                  <td>
                    {m.branchIds === null
                      ? "All"
                      : `${String(m.branchIds.length)} branch${m.branchIds.length === 1 ? "" : "es"}`}
                  </td>
                  <td>
                    {m.status === "active" ? "Active" : <Badge tone="warning">Suspended</Badge>}
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(m);
                      }}
                      aria-label={`Change roles of ${m.userId === userId ? "yourself" : m.userId}`}
                    >
                      Change roles
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {members.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            busy={members.isFetchingNextPage}
            onClick={() => void members.fetchNextPage()}
          >
            Load more
          </Button>
        </div>
      ) : null}
      <section aria-labelledby="pending">
        <Stack>
          <h2 id="pending">Pending invites</h2>
          {invites.isPending ? (
            <SkeletonRows rows={2} label="Loading invites" />
          ) : (invites.data ?? []).length === 0 ? (
            <p className="muted">No pending invites.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {(invites.data ?? []).map((i) => (
                <li key={i.inviteId}>
                  {i.email}{" "}
                  {i.expired ? (
                    <Badge tone="warning">Expired</Badge>
                  ) : (
                    <span className="muted">
                      expires {new Date(i.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </section>
      <InviteDialog
        open={inviteOpen}
        roles={roles.data ?? []}
        onClose={() => {
          router.replace("/people");
        }}
      />
      <RolesDialog
        member={editing}
        roles={roles.data ?? []}
        onClose={() => {
          setEditing(null);
        }}
      />
    </Stack>
  );
}

export default function PeoplePage() {
  return (
    <Suspense>
      <PeopleView />
    </Suspense>
  );
}
