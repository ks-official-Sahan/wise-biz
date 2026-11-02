"use client";

import { useQueryClient } from "@tanstack/react-query";
import { uuidv7 } from "@wise-biz/ids";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

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
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import {
  barcodeSequenceSeed,
  catalogKeys,
  changeSummary,
  inStoreBarcode,
  useCategories,
  useProduct,
  useTags,
  useUnits,
} from "@/lib/catalog.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "../catalog.module.css";

import type { EditableProduct, EditableVariant, Product } from "@/lib/catalog.ts";
import type { SubmitEvent } from "react";

const TAX = /^[a-z][a-z0-9_]{0,31}$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

const blankVariant = (): EditableVariant => ({
  id: null,
  sku: "",
  name: "Default",
  taxCategory: "standard",
  unitId: null,
  tracksBatches: false,
  barcodes: [],
  version: 1,
});

function toEditable(p: Product): EditableProduct {
  return {
    name: p.name,
    description: p.description ?? "",
    categoryId: p.categoryId,
    tagIds: [...p.tagIds].sort(),
    variants: (p.variants ?? [])
      .filter((v) => !v.archived)
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        name: v.name,
        taxCategory: v.taxCategory,
        unitId: v.unitId,
        tracksBatches: v.tracksBatches,
        barcodes: (v.barcodes ?? []).map((b) => b.code),
        version: v.version,
      })),
  };
}

const splitCodes = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\s,|]+/)
      .map((c) => c.trim())
      .filter(Boolean),
  ),
];

/** Problems that would make the API refuse the form, found before sending. */
function problemsOf(p: EditableProduct): string[] {
  const out: string[] = [];
  if (p.name.trim() === "") out.push("Give the product a name.");
  const seen = new Set<string>();
  p.variants.forEach((v, i) => {
    const n = String(i + 1);
    if (!SKU.test(v.sku))
      out.push(`Variant ${n}: the SKU needs 1-64 letters, digits, . _ / - and no spaces.`);
    if (seen.has(v.sku.toLowerCase())) out.push(`Variant ${n}: the SKU ${v.sku} is used twice.`);
    seen.add(v.sku.toLowerCase());
    if (v.name.trim() === "") out.push(`Variant ${n}: give it a name.`);
    if (!TAX.test(v.taxCategory))
      out.push(
        `Variant ${n}: the tax category is lowercase letters, digits and _ (like standard).`,
      );
  });
  if (p.variants.length === 0) out.push("Add at least one variant.");
  return out;
}

export default function ProductEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params.id === "new" ? null : params.id;
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const router = useRouter();
  const qc = useQueryClient();
  const product = useProduct(t, id);
  const categories = useCategories(t);
  const tags = useTags(t);
  const units = useUnits(t);

  const [form, setForm] = useState<EditableProduct>({
    name: "",
    description: "",
    categoryId: null,
    tagIds: [],
    variants: [blankVariant()],
  });
  const [original, setOriginal] = useState<EditableProduct | null>(null);
  const [codeText, setCodeText] = useState<Record<number, string>>({});
  const [seed] = useState(barcodeSequenceSeed);
  // Ids are minted once per form, so a retry after a failed save sends the same ids (the API replays instead of creating twice).
  const minted = useRef({ product: uuidv7(), variants: new Map<number, string>() });
  const variantId = (i: number): string => {
    let v = minted.current.variants.get(i);
    if (v === undefined) {
      v = uuidv7();
      minted.current.variants.set(i, v);
    }
    return v;
  };
  const [review, setReview] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  // Load an existing product into the form once per fetched version (a reload after a conflict re-seeds it).
  useEffect(() => {
    const p = product.data;
    if (p === undefined || p.version === loadedVersion) return;
    const e = toEditable(p);
    // The form is seeded from the server copy; this is the one place server state flows into form state.
    /* eslint-disable react-hooks/set-state-in-effect */
    setForm(e);
    setOriginal(e);
    setCodeText(Object.fromEntries(e.variants.map((v, i) => [i, v.barcodes.join(", ")])));
    setLoadedVersion(p.version);
    setConflict(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [product.data, loadedVersion]);

  const codesOf = (i: number): string[] =>
    splitCodes(codeText[i] ?? form.variants[i]?.barcodes.join(", ") ?? "");
  const edited: EditableProduct = useMemo(
    () => ({
      ...form,
      name: form.name.trim(),
      variants: form.variants.map((v, i) => ({
        ...v,
        sku: v.sku.trim(),
        barcodes: splitCodes(codeText[i] ?? v.barcodes.join(", ")),
      })),
    }),
    [form, codeText],
  );

  const setVariant = (i: number, patch: Partial<EditableVariant>) => {
    setForm((f) => ({
      ...f,
      variants: f.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)),
    }));
  };

  function generate(i: number): void {
    // One sequence number per row position: two rows never get the same code, and a retry gets the same one.
    setCodeText((c) => ({ ...c, [i]: inStoreBarcode(seed + i) }));
  }

  function begin(): void {
    setError(null);
    const problems = problemsOf(edited);
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    const summary = changeSummary(original, edited);
    if (summary.length === 0 && id !== null) {
      setError("Nothing has changed.");
      return;
    }
    // Critical fields (tax, SKU, barcodes) and new products are confirmed; a plain rename saves straight away.
    const critical =
      id === null || summary.some((l) => /tax category|SKU|barcodes|Add variant/.test(l));
    if (critical) setReview(summary);
    else void save();
  }

  async function save(): Promise<void> {
    setReview(null);
    setBusy(true);
    setError(null);
    try {
      const variantBody = (v: EditableVariant, i: number) => ({
        id: variantId(i),
        sku: v.sku,
        name: v.name.trim(),
        unitId: v.unitId,
        tracksBatches: v.tracksBatches,
        taxCategory: v.taxCategory,
        barcodes: v.barcodes.map((code) => ({ code })),
      });
      if (id === null) {
        const created = await api<Product>("POST", "/v1/catalog/products", {
          body: {
            id: minted.current.product,
            name: edited.name,
            ...(edited.description === "" ? {} : { description: edited.description }),
            categoryId: edited.categoryId,
            tagIds: edited.tagIds,
            variants: edited.variants.map((v, i) => variantBody(v, i)),
          },
        });
        await qc.invalidateQueries({ queryKey: catalogKeys.all(t) });
        router.replace(`/catalog/${created.id}` as never);
        return;
      }
      const before = original;
      const current = product.data;
      if (current === undefined) throw new Error("Reload the product first.");
      const productSame =
        before !== null &&
        before.name === edited.name &&
        before.description === edited.description &&
        before.categoryId === edited.categoryId &&
        before.tagIds.join("|") === edited.tagIds.join("|");
      if (!productSame) {
        await api("PATCH", `/v1/catalog/products/${id}`, {
          body: {
            version: current.version,
            name: edited.name,
            description: edited.description === "" ? null : edited.description,
            categoryId: edited.categoryId,
            tagIds: edited.tagIds,
          },
        });
      }
      for (const [i, v] of edited.variants.entries()) {
        const old = v.id === null ? undefined : before?.variants.find((x) => x.id === v.id);
        if (old === undefined || v.id === null) {
          await api("POST", `/v1/catalog/products/${id}/variants`, { body: variantBody(v, i) });
          continue;
        }
        if (
          old.sku !== v.sku ||
          old.name !== v.name ||
          old.unitId !== v.unitId ||
          old.tracksBatches !== v.tracksBatches ||
          old.taxCategory !== v.taxCategory
        ) {
          await api("PATCH", `/v1/catalog/variants/${v.id}`, {
            body: {
              version: old.version,
              sku: v.sku,
              name: v.name.trim(),
              unitId: v.unitId,
              tracksBatches: v.tracksBatches,
              taxCategory: v.taxCategory,
            },
          });
        }
        if (old.barcodes.join("|") !== v.barcodes.join("|")) {
          await api("PUT", `/v1/catalog/variants/${v.id}/barcodes`, {
            body: { barcodes: v.barcodes.map((code) => ({ code })) },
          });
        }
      }
      await qc.invalidateQueries({ queryKey: catalogKeys.all(t) });
      setLoadedVersion(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else if (e instanceof ApiError)
        setError(
          e.problem.errors?.map((x) => `${x.path}: ${x.message}`).join(" · ") ??
            e.problem.detail ??
            e.message,
        );
      else setError(e instanceof Error ? e.message : "Saving failed. Try again.");
      if (id !== null && !(e instanceof ApiError && e.status === 409)) {
        // Part of the save may have gone through: show what is stored now so the next save starts from the truth.
        setError(
          (m) =>
            `${m ?? "Saving failed."} Some changes may have been saved; the form now shows what is stored. Check it and save again.`,
        );
        setLoadedVersion(null);
        void product.refetch();
      }
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(archived: boolean): Promise<void> {
    if (id === null || product.data === undefined) return;
    if (
      original !== null &&
      changeSummary(original, edited).length > 0 &&
      !globalThis.confirm(
        "You have unsaved changes. Archiving reloads the product and drops them. Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      await api("PATCH", `/v1/catalog/products/${id}`, {
        body: { version: product.data.version, archived },
      });
      await qc.invalidateQueries({ queryKey: catalogKeys.all(t) });
      setLoadedVersion(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      else setError("That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (id !== null && product.isPending) return <SkeletonRows label="Loading product" rows={6} />;
  if (id !== null && product.isError)
    return <ErrorState error={product.error} onRetry={() => void product.refetch()} />;

  const unitOptions = [
    { value: "", label: "Each" },
    ...(units.data ?? []).map((u) => ({ value: u.id, label: u.name })),
  ];

  return (
    <Stack>
      <Row spread>
        <h1>{id === null ? "New product" : (original?.name ?? "Product")}</h1>
        <Row>
          {product.data?.archived === true ? <Badge>Archived</Badge> : null}
          <LinkButton variant="secondary" href="/catalog">
            Back to products
          </LinkButton>
        </Row>
      </Row>

      {conflict ? (
        <Alert tone="danger">
          Someone else changed this product while you were editing.{" "}
          <Button
            variant="secondary"
            onClick={() => {
              setLoadedVersion(null);
              void product.refetch();
            }}
          >
            Load their changes
          </Button>
        </Alert>
      ) : null}
      {error === null ? null : <Alert tone="danger">{error}</Alert>}

      <form
        onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
          e.preventDefault();
          begin();
        }}
      >
        <Stack>
          <TextField
            label="Name"
            required
            value={form.name}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value });
            }}
          />
          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => {
              setForm({ ...form, description: e.target.value });
            }}
          />
          <SelectField
            label="Category"
            value={form.categoryId ?? ""}
            options={[
              { value: "", label: "No category" },
              ...(categories.data ?? []).map((c) => ({ value: c.id, label: c.path.join(" › ") })),
            ]}
            onChange={(e) => {
              setForm({ ...form, categoryId: e.target.value === "" ? null : e.target.value });
            }}
          />
          <fieldset>
            <legend>Tags</legend>
            <div className={s.chips}>
              {(tags.data ?? []).length === 0 ? <span className="muted">No tags yet.</span> : null}
              {(tags.data ?? []).map((tag) => (
                <label key={tag.id}>
                  <input
                    type="checkbox"
                    checked={form.tagIds.includes(tag.id)}
                    onChange={(e) => {
                      setForm({
                        ...form,
                        tagIds: (e.target.checked
                          ? [...form.tagIds, tag.id]
                          : form.tagIds.filter((x) => x !== tag.id)
                        ).sort(),
                      });
                    }}
                  />{" "}
                  {tag.name}
                </label>
              ))}
            </div>
          </fieldset>

          <h2>Variants</h2>
          {form.variants.map((v, i) => (
            <fieldset key={v.id ?? `new-${String(i)}`} className={s.variantRow}>
              <legend>{`Variant ${String(i + 1)}`}</legend>
              <TextField
                label="SKU"
                required
                value={v.sku}
                onChange={(e) => {
                  setVariant(i, { sku: e.target.value });
                }}
              />
              <TextField
                label="Variant name"
                required
                value={v.name}
                onChange={(e) => {
                  setVariant(i, { name: e.target.value });
                }}
              />
              <TextField
                label="Tax category"
                help="Matches a tax rule, like standard or zero_rated."
                value={v.taxCategory}
                onChange={(e) => {
                  setVariant(i, { taxCategory: e.target.value });
                }}
              />
              <SelectField
                label="Unit"
                value={v.unitId ?? ""}
                options={unitOptions}
                onChange={(e) => {
                  setVariant(i, { unitId: e.target.value === "" ? null : e.target.value });
                }}
              />
              <TextField
                label="Barcodes"
                help="Separate several with commas."
                value={codeText[i] ?? v.barcodes.join(", ")}
                onChange={(e) => {
                  setCodeText((c) => ({ ...c, [i]: e.target.value }));
                }}
              />
              <label>
                <input
                  type="checkbox"
                  checked={v.tracksBatches}
                  onChange={(e) => {
                    setVariant(i, { tracksBatches: e.target.checked });
                  }}
                />{" "}
                Tracks batches and expiry
              </label>
              {codesOf(i).length === 0 ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    generate(i);
                  }}
                >
                  Generate in-store barcode
                </Button>
              ) : null}
            </fieldset>
          ))}
          <Row>
            <Button
              variant="secondary"
              onClick={() => {
                setForm({ ...form, variants: [...form.variants, blankVariant()] });
              }}
            >
              Add variant
            </Button>
          </Row>

          <Row spread>
            {id !== null && product.data !== undefined ? (
              <Button
                variant={product.data.archived ? "secondary" : "danger"}
                busy={busy}
                onClick={() => void setArchived(!product.data.archived)}
              >
                {product.data.archived ? "Restore product" : "Archive product"}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" busy={busy}>
              {id === null ? "Create product" : "Save changes"}
            </Button>
          </Row>
        </Stack>
      </form>

      <Dialog
        open={review !== null}
        title={id === null ? "Create this product?" : "Review your changes"}
        onClose={() => {
          setReview(null);
        }}
      >
        <Stack>
          <ul className={s.summary}>
            {(review ?? []).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted">Tills pick this up on their next sync.</p>
          <Row spread>
            <Button
              variant="ghost"
              onClick={() => {
                setReview(null);
              }}
            >
              Keep editing
            </Button>
            <Button busy={busy} onClick={() => void save()}>
              Confirm and save
            </Button>
          </Row>
        </Stack>
      </Dialog>
    </Stack>
  );
}
