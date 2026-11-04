"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Dialog,
  ErrorState,
  LinkButton,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
  styles,
} from "@/components/ui.tsx";
import { VariantPicker } from "@/components/variant-picker.tsx";
import { ApiError, api } from "@/lib/api.ts";
import { useCategories } from "@/lib/catalog.ts";
import {
  buildPromotion,
  describePromotion,
  exampleEffect,
  formFromPromotion,
  formatPrice,
  newId,
  pricingKeys,
  publishProblems,
  useCoupons,
  usePromotion,
  useVariantNames,
} from "@/lib/pricing.ts";
import { useProfile } from "@/lib/queries.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../../pricing.module.css";

import type { Hit } from "@/components/variant-picker.tsx";
import type { Promotion, PromotionForm } from "@/lib/pricing.ts";

const EFFECTS = [
  { value: "percent", label: "Percentage off" },
  { value: "amount", label: "Amount off" },
  { value: "fixed-price", label: "Fixed price each" },
  { value: "bxgy", label: "Buy some, get some" },
  { value: "bundle", label: "Bundle price" },
] as const;

export default function PromotionPage() {
  const { id } = useParams<{ id: string }>();
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const promo = usePromotion(t, id);
  // Kept here: the editor remounts on every new version, and the message must survive that.
  const [notice, setNotice] = useState<string | null>(null);
  // Kept here because a save-then-failed-publish bumps the version, which remounts the editor and would drop a local error.
  const [failure, setFailure] = useState<string | null>(null);
  const profile = useProfile(t);
  const currency = profile.data?.currency;
  if (profile.isError)
    return (
      <ErrorState
        error={profile.error}
        onRetry={() => {
          void profile.refetch();
        }}
      />
    );
  if (promo.isPending || currency === undefined) return <SkeletonRows label="Loading promotion" />;
  if (promo.isError) {
    return (
      <ErrorState
        error={promo.error}
        onRetry={() => {
          void promo.refetch();
        }}
      />
    );
  }
  return (
    <Editor
      // A new version from the server (after a save or publish) resets the form to what is stored.
      key={`${promo.data.id}:${String(promo.data.version)}`}
      promo={promo.data}
      notice={notice}
      onNotice={setNotice}
      failure={failure}
      onFailure={setFailure}
      currency={currency ?? "USD"}
    />
  );
}

function Editor({
  promo,
  currency,
  notice,
  onNotice,
  failure,
  onFailure,
}: {
  promo: Promotion;
  currency: string;
  notice: string | null;
  onNotice: (message: string | null) => void;
  failure: string | null;
  onFailure: (message: string | null) => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const categories = useCategories(t);
  const draft = promo.status === "draft";
  const [form, setForm] = useState<PromotionForm>(() => formFromPromotion(promo, currency));
  const [labels, setLabels] = useState<ReadonlyMap<string, Hit>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const patch = (p: Partial<PromotionForm>) => {
    onNotice(null);
    setForm((f) => ({ ...f, ...p }));
  };

  const pickedIds = useMemo(
    () => [...form.variantIds, ...form.bundle.map((b) => b.variantId)],
    [form.variantIds, form.bundle],
  );
  const names = useVariantNames(t, pickedIds);
  const nameOf = (variantId: string): string => {
    const n = names.get(variantId);
    if (n !== undefined) return `${n.productName} · ${n.name}`;
    return labels.get(variantId)?.title ?? "…";
  };
  const remember = (h: Hit) => {
    setLabels((cur) => new Map(cur).set(h.variantId, h));
  };

  const built = useMemo(() => buildPromotion(form, currency), [form, currency]);
  const errors = built.ok ? {} : built.errors;
  const dirty = JSON.stringify(form) !== JSON.stringify(formFromPromotion(promo, currency));

  async function save(): Promise<Promotion | null> {
    if (!built.ok) {
      setError("Fix the highlighted fields first.");
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Promotion>("PATCH", `/v1/pricing/promotions/${promo.id}`, {
        body: { version: promo.version, ...built.body },
      });
      return saved;
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "Someone else changed this promotion. Reload to see their version."
          : e instanceof Error
            ? e.message
            : "Saving failed.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh(): Promise<void> {
    await qc.invalidateQueries({ queryKey: pricingKeys.all(t) });
  }

  async function onSave(): Promise<void> {
    const saved = await save();
    if (saved === null) return;
    onNotice("Draft saved.");
    await refresh();
  }

  async function onPublish(): Promise<void> {
    // Publish the stored draft: save first when the form changed, then publish that version.
    let version = promo.version;
    if (dirty) {
      const saved = await save();
      if (saved === null) return;
      version = saved.version;
    }
    setBusy(true);
    setError(null);
    onFailure(null);
    try {
      await api("POST", `/v1/pricing/promotions/${promo.id}/publish`, { body: { version } });
      setPublishing(false);
      await refresh();
    } catch (e) {
      onFailure(e instanceof Error ? e.message : "Publishing failed.");
      setPublishing(false);
      // The save may have gone through (version N to N+1): refresh so the next save does not 409.
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onArchive(): Promise<void> {
    if (!globalThis.confirm("Archive this promotion? Tills stop applying it after the next sync."))
      return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/pricing/promotions/${promo.id}/archive`, {
        body: { version: promo.version },
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Archiving failed.");
    } finally {
      setBusy(false);
    }
  }

  const stored = formFromPromotion(promo, currency);
  const view = draft ? form : stored;
  const lock = !draft;
  const problems = built.ok ? publishProblems(built.body) : [];
  const unitExample = 1000;

  return (
    <Stack>
      <Row spread>
        <div>
          <h1>{promo.name}</h1>
          <p className={styles.muted}>
            <Badge tone={promo.status === "published" ? "accent" : "neutral"}>{promo.status}</Badge>{" "}
            {describePromotion(promo, currency)}
          </p>
        </div>
        <LinkButton variant="secondary" href="/pricing">
          All pricing
        </LinkButton>
      </Row>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      {notice === null ? null : <Alert tone="success">{notice}</Alert>}
      {failure === null ? null : <Alert tone="danger">{failure}</Alert>}
      {lock ? (
        <Alert tone="info">
          Published and archived promotions cannot be edited. Copy the settings into a new draft to
          change them.
        </Alert>
      ) : null}

      <fieldset disabled={lock} className={s.form}>
        <legend>
          <h2>Details</h2>
        </legend>
        <TextField
          label="Name"
          required
          value={view.name}
          error={errors.name}
          onChange={(e) => {
            patch({ name: e.target.value });
          }}
        />
        <div className={s.grid}>
          <TextField
            label="Priority"
            inputMode="numeric"
            value={view.priority}
            help="Higher runs first."
            error={errors.priority}
            onChange={(e) => {
              patch({ priority: e.target.value });
            }}
          />
          <SelectField
            label="Works with other promotions"
            value={view.stackable ? "yes" : "no"}
            options={[
              { value: "yes", label: "Yes, can stack" },
              { value: "no", label: "No, best one wins" },
            ]}
            onChange={(e) => {
              patch({ stackable: e.target.value === "yes" });
            }}
          />
        </div>

        <h2>Applies to</h2>
        <SelectField
          label="Applies to"
          value={view.targetKind}
          options={[
            { value: "cart", label: "The whole cart" },
            { value: "items", label: "Chosen products or categories" },
          ]}
          onChange={(e) => {
            patch({ targetKind: e.target.value as "cart" | "items" });
          }}
        />
        {view.targetKind === "items" ? (
          <>
            <VariantPicker
              label="Add a product"
              onPick={(h) => {
                remember(h);
                patch({ variantIds: [...new Set([...form.variantIds, h.variantId])] });
              }}
            />
            {view.variantIds.length === 0 ? null : (
              <ul className={s.summary}>
                {view.variantIds.map((v) => (
                  <li key={v}>
                    {nameOf(v)}{" "}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        patch({ variantIds: form.variantIds.filter((x) => x !== v) });
                      }}
                    >
                      {`Remove ${nameOf(v)}`}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <SelectField
              label="Add a category"
              value=""
              options={[
                { value: "", label: "Choose…" },
                ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.path.join(" › ") })),
              ]}
              onChange={(e) => {
                if (e.target.value !== "")
                  patch({ categoryIds: [...new Set([...form.categoryIds, e.target.value])] });
              }}
            />
            {view.categoryIds.length === 0 ? null : (
              <ul className={s.summary}>
                {view.categoryIds.map((c) => (
                  <li key={c}>
                    {categories.data?.find((x) => x.id === c)?.path.join(" › ") ?? "Category"}{" "}
                    <Button
                      variant="ghost"
                      onClick={() => {
                        patch({ categoryIds: form.categoryIds.filter((x) => x !== c) });
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        <h2>Discount</h2>
        <SelectField
          label="Type"
          value={view.effectKind}
          options={EFFECTS}
          error={errors.effectKind}
          onChange={(e) => {
            patch({ effectKind: e.target.value as PromotionForm["effectKind"] });
          }}
        />
        {view.effectKind === "percent" ? (
          <TextField
            label="Percentage off"
            inputMode="decimal"
            value={view.percent}
            error={errors.percent}
            onChange={(e) => {
              patch({ percent: e.target.value });
            }}
          />
        ) : null}
        {view.effectKind === "amount" ? (
          <TextField
            label={`Amount off (${currency})`}
            inputMode="decimal"
            value={view.amount}
            error={errors.amount}
            onChange={(e) => {
              patch({ amount: e.target.value });
            }}
          />
        ) : null}
        {view.effectKind === "fixed-price" ? (
          <TextField
            label={`Price each (${currency})`}
            inputMode="decimal"
            value={view.fixedPrice}
            error={errors.fixedPrice}
            onChange={(e) => {
              patch({ fixedPrice: e.target.value });
            }}
          />
        ) : null}
        {view.effectKind === "bxgy" ? (
          <div className={s.grid}>
            <TextField
              label="Customer buys"
              inputMode="numeric"
              value={view.buy}
              error={errors.buy}
              onChange={(e) => {
                patch({ buy: e.target.value });
              }}
            />
            <TextField
              label="Customer gets"
              inputMode="numeric"
              value={view.get}
              error={errors.get}
              onChange={(e) => {
                patch({ get: e.target.value });
              }}
            />
            <TextField
              label="Discount on those (%)"
              inputMode="decimal"
              value={view.getPercent}
              help="100 means free."
              error={errors.getPercent}
              onChange={(e) => {
                patch({ getPercent: e.target.value });
              }}
            />
          </div>
        ) : null}
        {view.effectKind === "bundle" ? (
          <>
            <VariantPicker
              label="Add a product to the bundle"
              onPick={(h) => {
                remember(h);
                if (!form.bundle.some((b) => b.variantId === h.variantId))
                  patch({ bundle: [...form.bundle, { variantId: h.variantId, qty: "1" }] });
              }}
            />
            {errors.bundle === undefined ? null : <p role="alert">{errors.bundle}</p>}
            {view.bundle.map((b, i) => (
              <Row key={b.variantId}>
                <span>{nameOf(b.variantId)}</span>
                <TextField
                  label={`Quantity of ${nameOf(b.variantId)}`}
                  inputMode="numeric"
                  value={b.qty}
                  error={errors[`bundle.${String(i)}`]}
                  onChange={(e) => {
                    patch({
                      bundle: form.bundle.map((x) =>
                        x.variantId === b.variantId ? { ...x, qty: e.target.value } : x,
                      ),
                    });
                  }}
                />
                <Button
                  variant="ghost"
                  onClick={() => {
                    patch({ bundle: form.bundle.filter((x) => x.variantId !== b.variantId) });
                  }}
                >
                  {`Remove ${nameOf(b.variantId)}`}
                </Button>
              </Row>
            ))}
            <TextField
              label={`Bundle price (${currency})`}
              inputMode="decimal"
              value={view.bundlePrice}
              error={errors.bundlePrice}
              onChange={(e) => {
                patch({ bundlePrice: e.target.value });
              }}
            />
          </>
        ) : null}

        <h2>Conditions</h2>
        <div className={s.grid}>
          <TextField
            label="Starts"
            type="datetime-local"
            value={view.startsAt}
            onChange={(e) => {
              patch({ startsAt: e.target.value });
            }}
          />
          <TextField
            label="Ends"
            type="datetime-local"
            value={view.endsAt}
            error={errors.endsAt}
            onChange={(e) => {
              patch({ endsAt: e.target.value });
            }}
          />
          <TextField
            label="Minimum quantity"
            inputMode="decimal"
            value={view.minQty}
            error={errors.minQty}
            onChange={(e) => {
              patch({ minQty: e.target.value });
            }}
          />
          <TextField
            label={`Minimum spend (${currency})`}
            inputMode="decimal"
            value={view.minAmount}
            error={errors.minAmount}
            onChange={(e) => {
              patch({ minAmount: e.target.value });
            }}
          />
        </div>
        <TextField
          label="Customer groups"
          value={view.groups}
          help="Comma list. Leave empty for everyone."
          onChange={(e) => {
            patch({ groups: e.target.value });
          }}
        />
        <label>
          <input
            type="checkbox"
            checked={view.requiresCoupon}
            onChange={(e) => {
              patch({ requiresCoupon: e.target.checked });
            }}
          />{" "}
          Only with a coupon code
        </label>
      </fieldset>

      {promo.requiresCoupon ? <Coupons promotionId={promo.id} /> : null}

      <div className={s.stickybar}>
        <Row spread>
          <span role="status">{draft && dirty ? "Unsaved changes." : ""}</span>
          <Row>
            {draft ? (
              <>
                <Button
                  variant="secondary"
                  busy={busy}
                  disabled={!dirty}
                  onClick={() => void onSave()}
                >
                  Save draft
                </Button>
                <Button
                  disabled={!built.ok}
                  onClick={() => {
                    setPublishing(true);
                  }}
                >
                  Review and publish
                </Button>
              </>
            ) : null}
            {promo.status === "published" ? (
              <Button variant="danger" busy={busy} onClick={() => void onArchive()}>
                Archive
              </Button>
            ) : null}
          </Row>
        </Row>
      </div>

      <Dialog
        open={publishing}
        title="Publish this promotion?"
        onClose={() => {
          setPublishing(false);
        }}
      >
        {built.ok ? (
          <Stack>
            <p>{describePromotion(built.body, currency)}</p>
            <div className={s.preview}>
              <p>{`Example: 2 items at ${formatPrice(unitExample, currency)} each`}</p>
              {(() => {
                const ex = exampleEffect(built.body.effect, unitExample, 2);
                return (
                  <p>
                    <span className={s.strike}>{formatPrice(ex.before, currency)}</span>{" "}
                    <strong>{formatPrice(ex.after, currency)}</strong>
                  </p>
                );
              })()}
            </div>
            {problems.length > 0 ? (
              <Alert tone="danger">
                <ul className={s.summary}>
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            <p className={styles.muted}>
              After publishing you cannot edit it. Tills apply it after their next sync.
            </p>
            <Row spread>
              <Button
                variant="ghost"
                onClick={() => {
                  setPublishing(false);
                }}
              >
                Keep editing
              </Button>
              <Button busy={busy} disabled={problems.length > 0} onClick={() => void onPublish()}>
                Publish
              </Button>
            </Row>
          </Stack>
        ) : null}
      </Dialog>
    </Stack>
  );
}

function Coupons({ promotionId }: { promotionId: string }) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const coupons = useCoupons(t, promotionId, true);
  const [code, setCode] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [couponId, setCouponId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(): Promise<void> {
    if (maxUses.trim() !== "" && !/^[1-9]\d{0,8}$/.test(maxUses.trim())) {
      setError("Maximum uses must be a whole number of 1 or more, or empty for no limit.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/v1/pricing/promotions/${promotionId}/coupons`, {
        body: {
          id: couponId,
          code: code.trim(),
          ...(maxUses.trim() === "" ? {} : { maxUses: Number(maxUses) }),
        },
      });
      setCode("");
      setMaxUses("");
      setCouponId(newId());
      await qc.invalidateQueries({ queryKey: pricingKeys.coupons(t, promotionId) });
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? "That code is already used."
          : e instanceof Error
            ? e.message
            : "Could not add the code.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack>
      <h2>Coupon codes</h2>
      {error === null ? null : <Alert tone="danger">{error}</Alert>}
      <div className={s.grid}>
        <TextField
          label="Code"
          value={code}
          help="3 to 32 letters, numbers, - or _. Not case sensitive."
          onChange={(e) => {
            setCode(e.target.value);
          }}
        />
        <TextField
          label="Maximum uses"
          inputMode="numeric"
          value={maxUses}
          help="Leave empty for no limit."
          onChange={(e) => {
            setMaxUses(e.target.value);
          }}
        />
      </div>
      <Row>
        <Button
          variant="secondary"
          busy={busy}
          disabled={code.trim() === ""}
          onClick={() => void add()}
        >
          Add code
        </Button>
      </Row>
      {coupons.data === undefined || coupons.data.length === 0 ? null : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="sr-only">Coupon codes</caption>
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col" className={s.num}>
                  Used
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {coupons.data.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.code}</th>
                  <td className={s.num}>
                    {c.maxUses === null
                      ? String(c.uses)
                      : `${String(c.uses)} of ${String(c.maxUses)}`}
                  </td>
                  <td>{c.active ? <Badge>Active</Badge> : <Badge tone="warning">Off</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Stack>
  );
}
