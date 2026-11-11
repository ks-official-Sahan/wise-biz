"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import { ConfirmAction } from "@/components/confirm-action.tsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  Empty,
  ErrorState,
  LinkButton,
  Row,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { api, isNotFound } from "@/lib/api.ts";
import { useCommand } from "@/lib/command.ts";
import {
  COUNT_STATUS_LABEL,
  countActions,
  countKeys,
  countLineStatusText,
  countProgressPercent,
  countProgressText,
  countVarianceText,
  expectedText,
  lineKey,
  lineValueText,
  useCount,
  useCountVariance,
  varianceTotalsText,
  buildGapThresholds,
  buildRecount,
} from "@/lib/counts.ts";
import { gapKeys } from "@/lib/gaps.ts";
import { parsePrice, useVariantNames } from "@/lib/pricing.ts";
import { useReturnFocus } from "@/lib/procurement.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import inv from "../../inventory.module.css";
import s from "../../purchasing/procurement.module.css";

import type { CountLine, CountStatus, CountVariance } from "@/lib/counts.ts";
import type { GapGenerateResult } from "@/lib/gaps.ts";
import type { ChangeEvent } from "react";

type OpenDialog = "gaps" | "recount" | "close" | "approve" | "cancel" | null;

export default function CountPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const detail = useCount(t, id);
  const header = detail.data?.pages[0]?.count;
  const lines = useMemo(() => detail.data?.pages.flatMap((p) => p.lines) ?? [], [detail.data]);
  const status: CountStatus | null = header?.status ?? null;
  const reviewed = status === "review" || status === "approved";
  const variance = useCountVariance(t, id, reviewed);
  const names = useVariantNames(t, [...new Set(lines.map((l) => l.variantId))]);
  const profile = useProfile(t);
  const focus = useReturnFocus();
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [zeroUncounted, setZeroUncounted] = useState(false);
  const [gapResult, setGapResult] = useState<GapGenerateResult | null>(null);

  const title = (variantId: string): string => {
    const v = names.get(variantId);
    return v === undefined ? "Product" : `${v.productName} · ${v.name}`;
  };

  const refresh = () => qc.invalidateQueries({ queryKey: countKeys.all(t) });
  const act = (path: string, body: unknown, key: string) =>
    api<unknown>("POST", `/v1/inventory/counts/${encodeURIComponent(id)}${path}`, {
      body,
      idempotencyKey: key,
    });

  const open = useCommand<null>(async (_, key) => {
    if (header === undefined) return;
    await act("/open", { version: header.version }, key);
    await refresh();
  });

  if (detail.isPending || header === undefined)
    return detail.isError ? (
      isNotFound(detail.error) ? (
        <Empty title="Count not found">It may have been removed, or your role cannot see it.</Empty>
      ) : (
        <ErrorState
          error={detail.error}
          onRetry={() => {
            void detail.refetch();
          }}
        />
      )
    ) : (
      <SkeletonRows label="Loading stock count" />
    );

  const actions = countActions(header.status);
  const percent = countProgressPercent(header);
  const canRecount = actions.recount;
  const picked = lines.filter((l) => selected.has(lineKey(l)));
  const recountBody = buildRecount(
    header.version,
    picked.map((l) => ({ variantId: l.variantId, batchId: l.batchId })),
  );
  const v: CountVariance | undefined = variance.data;
  const totals = v === undefined ? null : varianceTotalsText(v.totals, header.currency);
  const togglePick = (l: CountLine, on: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(lineKey(l));
      else next.delete(lineKey(l));
      return next;
    });
  };

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{`${header.kind === "full" ? "Full" : "Cycle"} count`}</h1>
          <p className={styles.muted}>
            {`${header.mode === "frozen" ? "Frozen" : "Live"}${header.blind ? ", blind" : ""} · opened ${header.openedAt.slice(0, 10)}`}
          </p>
        </div>
        <div className={s.actions}>
          <LinkButton variant="secondary" href="/counts">
            All counts
          </LinkButton>
          {actions.cancel ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                focus.remember(e.currentTarget);
                setDialog("cancel");
              }}
            >
              Cancel count
            </Button>
          ) : null}
          {actions.recount ? (
            <Button
              variant="secondary"
              disabled={picked.length === 0}
              onClick={(e) => {
                focus.remember(e.currentTarget);
                setDialog("recount");
              }}
            >
              {`Request recount${picked.length === 0 ? "" : ` (${String(picked.length)})`}`}
            </Button>
          ) : null}
          {actions.close ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                focus.remember(e.currentTarget);
                setZeroUncounted(false);
                setDialog("close");
              }}
            >
              Close counting
            </Button>
          ) : null}
          {actions.approve ? (
            <Button
              onClick={(e) => {
                focus.remember(e.currentTarget);
                setDialog("approve");
              }}
            >
              Approve variances
            </Button>
          ) : null}
          {actions.gaps ? (
            <Button
              variant="secondary"
              onClick={(e) => {
                focus.remember(e.currentTarget);
                setDialog("gaps");
              }}
            >
              Create gap cases
            </Button>
          ) : null}
          {actions.open ? (
            <Button
              busy={open.busy}
              onClick={() => {
                void open.submit(null);
              }}
            >
              Open counting
            </Button>
          ) : null}
        </div>
      </Row>

      {open.error === null ? null : <Alert tone="danger">{open.error}</Alert>}
      {gapResult === null ? null : (
        <Alert tone="success">
          <Row spread>
            <span>
              {`Created ${String(gapResult.created)} gap ${gapResult.created === 1 ? "case" : "cases"}. ${String(gapResult.existing)} lines already had one.`}
            </span>
            <LinkButton variant="secondary" href="/gaps">
              Open stock gaps
            </LinkButton>
          </Row>
        </Alert>
      )}

      <Card>
        <Stack>
          <Row spread>
            <Badge tone={header.status === "review" ? "accent" : "neutral"}>
              {COUNT_STATUS_LABEL[header.status]}
            </Badge>
            <span>{countProgressText(header)}</span>
          </Row>
          <progress
            className={inv.progress}
            value={percent}
            max={100}
            aria-label={`Lines counted: ${countProgressText(header)}`}
          />
          <dl className={inv.summary}>
            <div>
              <dt>Currency</dt>
              <dd>{header.currency}</dd>
            </div>
            <div>
              <dt>Closed</dt>
              <dd>{header.closedAt?.slice(0, 10) ?? "Not yet"}</dd>
            </div>
            <div>
              <dt>Approved</dt>
              <dd>{header.approvedAt?.slice(0, 10) ?? "Not yet"}</dd>
            </div>
          </dl>
          {header.note === "" ? null : <p>{header.note}</p>}
        </Stack>
      </Card>

      {header.status === "draft" ? (
        <Empty title="This count has not started">
          Open counting to let devices record scans. Lines appear as they are counted.
        </Empty>
      ) : null}

      <h2>Lines</h2>
      {lines.length === 0 ? (
        <Empty title="No lines yet">Lines appear when the count is taken at its location.</Empty>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Lines of this count, with scan totals</caption>
            <thead>
              <tr>
                {canRecount ? <th scope="col">Recount</th> : null}
                <th scope="col">Product</th>
                <th scope="col" className={inv.num}>
                  Counted
                </th>
                <th scope="col" className={inv.num}>
                  Expected
                </th>
                <th scope="col">Line status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const key = lineKey(l);
                const name = title(l.variantId);
                return (
                  <tr key={key}>
                    {canRecount ? (
                      <td>
                        <label className={inv.check}>
                          <input
                            type="checkbox"
                            aria-label={`Recount ${name}`}
                            checked={selected.has(key)}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              togglePick(l, e.target.checked);
                            }}
                          />
                        </label>
                      </td>
                    ) : null}
                    <th scope="row">{name}</th>
                    <td className={inv.num}>{l.countedQty ?? "Not counted"}</td>
                    <td className={inv.num}>{expectedText(l.expectedQty)}</td>
                    <td>{countLineStatusText(l)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {detail.hasNextPage ? (
        <Button
          variant="secondary"
          busy={detail.isFetchingNextPage}
          onClick={() => {
            void detail.fetchNextPage();
          }}
        >
          Load more lines
        </Button>
      ) : null}

      {reviewed ? (
        <>
          <h2>Variance</h2>
          {variance.isPending ? <SkeletonRows label="Loading variance" /> : null}
          {variance.isError ? (
            <ErrorState
              error={variance.error}
              onRetry={() => {
                void variance.refetch();
              }}
            />
          ) : null}
          {v === undefined ? null : (
            <>
              {totals === null ? null : (
                <dl className={inv.summary}>
                  <div>
                    <dt>Short</dt>
                    <dd>{totals.short}</dd>
                  </div>
                  <div>
                    <dt>Over</dt>
                    <dd>{totals.over}</dd>
                  </div>
                  <div>
                    <dt>Valuation</dt>
                    <dd>{totals.unvalued}</dd>
                  </div>
                </dl>
              )}
              {v.lines.length === 0 ? (
                <Empty title="No variance">Every counted line matches the system.</Empty>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <caption className="sr-only">Variance per line</caption>
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        <th scope="col" className={inv.num}>
                          Expected
                        </th>
                        <th scope="col" className={inv.num}>
                          Counted
                        </th>
                        <th scope="col">Variance</th>
                        <th scope="col">Value impact</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.lines.map((l) => (
                        <tr key={`${l.variantId}|${l.batchId ?? ""}`}>
                          <th scope="row">{title(l.variantId)}</th>
                          <td className={inv.num}>{expectedText(l.expectedQty)}</td>
                          <td className={inv.num}>{l.countedQty ?? "Not counted"}</td>
                          <td>{countVarianceText(l.varianceQty)}</td>
                          <td>{lineValueText(l, header.currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      ) : null}

      {dialog === "cancel" ? (
        <ConfirmAction
          title="Cancel this count?"
          confirmLabel="Cancel count"
          danger
          onClose={() => {
            setDialog(null);
            focus.restore();
          }}
          run={(key) => act("/cancel", { version: header.version }, key).then(refresh)}
        >
          <p>Nothing has been posted, so no stock is affected.</p>
        </ConfirmAction>
      ) : null}

      {dialog === "close" ? (
        <ConfirmAction
          title="Close counting?"
          confirmLabel="Close counting"
          onClose={() => {
            setDialog(null);
            focus.restore();
          }}
          run={(key) =>
            act("/close", { version: header.version, zeroUncounted }, key).then(refresh)
          }
        >
          <p>Scans stop being accepted. The count then waits for review.</p>
          <label className={inv.check}>
            <input
              type="checkbox"
              checked={zeroUncounted}
              aria-describedby="zero-help"
              onChange={(e) => {
                setZeroUncounted(e.target.checked);
              }}
            />
            <span>Book lines nobody counted as zero</span>
          </label>
          <p id="zero-help" className={inv.help}>
            Without this, uncounted lines block approval.
          </p>
        </ConfirmAction>
      ) : null}

      {dialog === "recount" ? (
        <ConfirmAction
          title="Request a recount?"
          confirmLabel={`Recount ${String(picked.length)} ${picked.length === 1 ? "line" : "lines"}`}
          onClose={() => {
            setDialog(null);
            focus.restore();
          }}
          run={(key) => {
            if (!recountBody.ok)
              return Promise.reject(new Error("Pick at least one line to recount."));
            return act("/recounts", recountBody.body, key).then(async () => {
              setSelected(new Set());
              await refresh();
            });
          }}
        >
          <p>Counted quantities for these lines are cleared, and the counter counts them again.</p>
          <ul>
            {picked.map((l) => (
              <li key={lineKey(l)}>{title(l.variantId)}</li>
            ))}
          </ul>
        </ConfirmAction>
      ) : null}

      {dialog === "approve" ? (
        <ConfirmAction
          title="Approve these variances?"
          confirmLabel="Approve variances"
          onClose={() => {
            setDialog(null);
            focus.restore();
          }}
          run={(key) => act("/approve", { version: header.version }, key).then(refresh)}
        >
          <p>
            Each variance posts to stock as a count correction. This cannot be taken back. Approval
            is refused if stock moved during a frozen count.
          </p>
          {totals === null ? null : <p className={inv.help}>{totals.unvalued}</p>}
        </ConfirmAction>
      ) : null}

      {dialog === "gaps" ? (
        <GapDialog
          countId={header.id}
          currency={profile.data?.currency ?? header.currency}
          onDone={(r) => {
            setGapResult(r);
            setDialog(null);
            focus.restore();
          }}
          onClose={() => {
            setDialog(null);
            focus.restore();
          }}
        />
      ) : null}
    </Stack>
  );
}

/** Creates gap cases from an approved count over a quantity, a value or both. Idempotent per line on the server. */
function GapDialog({
  countId,
  currency,
  onDone,
  onClose,
}: {
  readonly countId: string;
  readonly currency: string;
  readonly onDone: (r: GapGenerateResult) => void;
  readonly onClose: () => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const [minQty, setMinQty] = useState("");
  const [minValue, setMinValue] = useState("");
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const cmd = useCommand<null>(async (_, key) => {
    const built = buildGapThresholds(minQty, minValue, (text) => parsePrice(text, currency));
    if (!built.ok) {
      setErrors(built.errors);
      throw new Error("Check the highlighted fields.");
    }
    setErrors(new Map());
    const r = await api<GapGenerateResult>(
      "POST",
      `/v1/inventory/counts/${encodeURIComponent(countId)}/gaps`,
      {
        body: built.body,
        idempotencyKey: key,
      },
    );
    await qc.invalidateQueries({ queryKey: gapKeys.all(t) });
    onDone(r);
  });
  return (
    <Dialog open title="Create gap cases" onClose={onClose}>
      <form
        className={s.form}
        onSubmit={(e) => {
          e.preventDefault();
          void cmd.submit(null);
        }}
      >
        {cmd.error === null ? null : <Alert tone="danger">{cmd.error}</Alert>}
        <p>
          Lines short by at least this quantity, or worth at least this much, become cases to
          investigate. Lines with no cost are cases under a value threshold, never valued at zero.
        </p>
        <TextField
          label="Quantity threshold"
          inputMode="decimal"
          help="Like 2 or 0.5. Leave blank to use the value only."
          value={minQty}
          error={errors.get("minQty")}
          onChange={(e) => {
            setMinQty(e.target.value);
          }}
        />
        <TextField
          label={`Value threshold (${currency})`}
          inputMode="decimal"
          help="Like 10.00. Leave blank to use the quantity only."
          value={minValue}
          error={errors.get("minValueMinor")}
          onChange={(e) => {
            setMinValue(e.target.value);
          }}
        />
        <Row spread>
          <Button variant="ghost" disabled={cmd.busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={cmd.busy}>
            Create cases
          </Button>
        </Row>
      </form>
    </Dialog>
  );
}
