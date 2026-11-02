"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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
  cx,
  styles,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { actionsFor, ago, deviceKeys, presence, useDevices } from "@/lib/devices.ts";
import { useBranches } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../ops.module.css";

import type { Device, DeviceAction, EnrollmentCode } from "@/lib/devices.ts";
import type { SubmitEvent } from "react";

/** A clock that ticks every 30 s, so "last seen" and the online dot stay current without a refetch. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, ms);
    return () => {
      clearInterval(id);
    };
  }, [ms]);
  return now;
}

const PLATFORM: Readonly<Record<Device["platform"], string>> = {
  android: "Android",
  ios: "iPhone / iPad",
  windows: "Windows",
  macos: "Mac",
  linux: "Linux",
  web: "Browser",
};

export default function DevicesPage() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const devices = useDevices(t);
  const branches = useBranches(t);
  const now = useNow(30_000);
  const [enrolling, setEnrolling] = useState(false);
  const [acting, setActing] = useState<{ device: Device; action: DeviceAction } | null>(null);
  const [editing, setEditing] = useState<Device | null>(null);
  const branchName = new Map((branches.data ?? []).map((b) => [b.branchId, b.name]));
  const live = (devices.data ?? []).filter(
    (d) => d.status !== "revoked" && d.status !== "blacklisted",
  );
  const retired = (devices.data ?? []).filter(
    (d) => d.status === "revoked" || d.status === "blacklisted",
  );
  const online = live.filter((d) => d.status === "active" && presence(d, now) === "online").length;

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>Terminals</h1>
          {devices.isSuccess ? (
            <p className={styles.muted}>{`${String(online)} of ${String(live.length)} online`}</p>
          ) : null}
        </div>
        <Button
          onClick={() => {
            setEnrolling(true);
          }}
        >
          Add a terminal
        </Button>
      </Row>

      {devices.isPending ? <SkeletonRows label="Loading terminals" /> : null}
      {devices.isError ? (
        <ErrorState
          error={devices.error}
          onRetry={() => {
            void devices.refetch();
          }}
        />
      ) : null}
      {devices.isSuccess && live.length === 0 ? (
        <Empty title="No terminals yet">
          Add one to get a code, then type it on the new terminal.
        </Empty>
      ) : null}
      {live.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Terminals</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Branch</th>
                <th scope="col">Device</th>
                <th scope="col">Last seen</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {live.map((d) => {
                const p = presence(d, now);
                return (
                  <tr key={d.deviceId}>
                    <th scope="row">{d.name}</th>
                    <td>{branchName.get(d.branchId) ?? "…"}</td>
                    <td>{`${PLATFORM[d.platform]} · v${d.appVersion}`}</td>
                    <td>
                      <span
                        aria-hidden
                        className={cx(
                          s.dot,
                          p === "online" && d.status === "active" && s.dotOnline,
                        )}
                      />
                      {p === "online" && d.status === "active" ? "Online" : ago(d.lastSeenAt, now)}
                    </td>
                    <td>
                      {d.status === "active" ? (
                        <Badge>Active</Badge>
                      ) : d.status === "pending" ? (
                        <Badge tone="accent">Waiting</Badge>
                      ) : (
                        <Badge tone="warning">Suspended</Badge>
                      )}
                    </td>
                    <td>
                      <Row>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditing(d);
                          }}
                        >
                          {`Edit ${d.name}`}
                        </Button>
                        {actionsFor(d.status).map((a) => (
                          <Button
                            key={a.status}
                            variant={a.danger ? "danger" : "secondary"}
                            onClick={() => {
                              setActing({ device: d, action: a });
                            }}
                          >
                            {`${a.label} ${d.name}`}
                          </Button>
                        ))}
                      </Row>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {retired.length === 0 ? null : (
        <p className={styles.muted}>
          {`${String(retired.length)} removed terminal(s): ${retired.map((d) => `${d.name} (${d.status})`).join(", ")}`}
        </p>
      )}

      {enrolling ? (
        <EnrollDialog
          onClose={() => {
            setEnrolling(false);
          }}
        />
      ) : null}
      {acting === null ? null : (
        <ActionDialog
          device={acting.device}
          action={acting.action}
          onClose={() => {
            setActing(null);
          }}
        />
      )}
      {editing === null ? null : (
        <EditDialog
          device={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
    </Stack>
  );
}

function EnrollDialog({ onClose }: { onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const branches = useBranches(t);
  const active = (branches.data ?? []).filter((b) => !b.archived);
  const [branchPick, setBranchPick] = useState("");
  const branchId = branchPick !== "" ? branchPick : (active[0]?.branchId ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<EnrollmentCode | null>(null);
  const [copyNote, setCopyNote] = useState("");

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // No retry key on purpose: a new click makes a new code (the plain code is never stored by the API).
      setCode(
        await api<EnrollmentCode>("POST", "/v1/devices/enrollment-codes", {
          body: { branchId, name: name.trim() },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not make a code. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Add a terminal" onClose={onClose}>
      {code === null ? (
        <form
          className={s.form}
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          {error === null ? null : <Alert tone="danger">{error}</Alert>}
          <SelectField
            label="Branch"
            value={branchId}
            options={active.map((b) => ({ value: b.branchId, label: b.name }))}
            onChange={(e) => {
              setBranchPick(e.target.value);
            }}
          />
          <TextField
            label="Terminal name"
            required
            value={name}
            help="Shown on receipts and reports, like Front counter."
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <Row spread>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={branchId === "" || name.trim() === ""}>
              Make a code
            </Button>
          </Row>
        </form>
      ) : (
        <Stack>
          <p>Type this code on the new terminal. It works once and expires in 15 minutes.</p>
          <p
            style={{
              fontSize: "2rem",
              letterSpacing: "0.15em",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <strong aria-hidden>{code.code}</strong>
            <span className="sr-only">{`Code ${code.code.split("").join(" ")}`}</span>
          </p>
          <p
            className={styles.muted}
          >{`Expires ${new Date(code.expiresAt).toLocaleTimeString()}. It is shown only now.`}</p>
          <Row spread>
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(code.code).then(
                  () => {
                    setCopyNote("Copied.");
                  },
                  () => {
                    setCopyNote("Could not copy. Select the code and copy it by hand.");
                  },
                );
              }}
            >
              Copy code
            </Button>
            <Button onClick={onClose}>Done</Button>
          </Row>
          <p role="status">{copyNote}</p>
        </Stack>
      )}
    </Dialog>
  );
}

function ActionDialog({
  device,
  action,
  onClose,
}: {
  device: Device;
  action: DeviceAction;
  onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/v1/devices/${device.deviceId}`, { body: { status: action.status } });
      await qc.invalidateQueries({ queryKey: deviceKeys.all(t) });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "You may not change terminals, or it is already gone."
          : err instanceof Error
            ? err.message
            : "Could not change the terminal.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title={`${action.label} ${device.name}?`} onClose={onClose}>
      <Stack>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <p>{action.confirm}</p>
        <Row spread>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Keep it as it is
          </Button>
          <Button
            variant={action.danger ? "danger" : "primary"}
            busy={busy}
            onClick={() => void run()}
          >
            {action.label}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  );
}

function EditDialog({ device, onClose }: { device: Device; onClose: () => void }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const branches = useBranches(t);
  const [name, setName] = useState(device.name);
  const [branchId, setBranchId] = useState(device.branchId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const body = {
      ...(name.trim() !== device.name ? { name: name.trim() } : {}),
      ...(branchId !== device.branchId ? { branchId } : {}),
    };
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/v1/devices/${device.deviceId}`, { body });
      await qc.invalidateQueries({ queryKey: deviceKeys.all(t) });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="Edit terminal" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        <TextField
          label="Name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <SelectField
          label="Branch"
          value={branchId}
          options={(branches.data ?? [])
            .filter((b) => !b.archived || b.branchId === device.branchId)
            .map((b) => ({ value: b.branchId, label: b.name }))}
          onChange={(e) => {
            setBranchId(e.target.value);
          }}
        />
        <Row spread>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={name.trim() === ""}>
            Save
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
