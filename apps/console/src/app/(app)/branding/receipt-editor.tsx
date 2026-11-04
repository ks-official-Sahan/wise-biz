"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  Alert,
  Button,
  ErrorState,
  Row,
  SelectField,
  SkeletonRows,
  Stack,
  TextField,
} from "@/components/ui.tsx";
import { ApiError, api } from "@/lib/api.ts";
import {
  BLOCKS,
  DEFAULT_BLOCKS,
  brandingKeys,
  moveBlock,
  renderPreview,
  templateProblems,
  useReceiptTemplates,
} from "@/lib/branding.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./branding.module.css";

import type { BlockType, ReceiptBlock, ReceiptTemplate } from "@/lib/branding.ts";

/** Icon buttons keep a 44 px touch target. */
const TARGET = { minWidth: 44, minHeight: 44 } as const;

export function ReceiptEditor() {
  const { tenant } = useTenant();
  const templates = useReceiptTemplates(tenant.tenantId);
  // Kept here: the editor remounts on every new version, and the message must survive that.
  const [notice, setNotice] = useState<string | null>(null);
  if (templates.isPending) return <SkeletonRows label="Loading receipt" />;
  if (templates.isError)
    return (
      <ErrorState
        error={templates.error}
        onRetry={() => {
          void templates.refetch();
        }}
      />
    );
  const stored = templates.data.find((x) => x.branchId === null) ?? null;
  return (
    <Editor
      key={`${stored?.id ?? "new"}:${String(stored?.version ?? 0)}`}
      stored={stored}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

function Editor({
  stored,
  notice,
  onNotice,
}: {
  stored: ReceiptTemplate | null;
  notice: string | null;
  onNotice: (message: string | null) => void;
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const [paper, setPaper] = useState<"58" | "80">(stored?.paper ?? "80");
  const [prefix, setPrefix] = useState(stored?.invoicePrefix ?? "");
  const [footer, setFooter] = useState(stored?.footerText ?? "");
  const [blocks, setBlocks] = useState<readonly ReceiptBlock[]>(stored?.blocks ?? DEFAULT_BLOCKS);
  const [add, setAdd] = useState<BlockType>("text");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems = templateProblems(blocks, prefix);
  const lines = renderPreview(blocks, paper, prefix, footer);
  const label = (type: BlockType) => BLOCKS.find((b) => b.type === type)?.label ?? type;

  const edit = (fn: () => void) => {
    onNotice(null);
    fn();
  };

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/v1/theming/receipt-templates", {
        body: {
          ...(stored === null ? {} : { version: stored.version }),
          paper,
          invoicePrefix: prefix,
          footerText: footer,
          blocks,
        },
      });
      onNotice("Saved. Terminals use it after their next sync.");
      await qc.invalidateQueries({ queryKey: brandingKeys.receipts(t) });
    } catch (e) {
      // A stale version: load what is stored now, so the next save starts from it.
      if (e instanceof ApiError && e.status === 409)
        await qc.invalidateQueries({ queryKey: brandingKeys.receipts(t) });
      setError(
        e instanceof ApiError && e.status === 409
          ? "Someone else changed this receipt. Reload to see their version."
          : e instanceof Error
            ? e.message
            : "Saving failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={s.split}>
      <Stack>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {notice === null ? null : <Alert tone="success">{notice}</Alert>}
        <div className={s.grid}>
          <SelectField
            label="Paper"
            value={paper}
            options={[
              { value: "80", label: "80 mm roll" },
              { value: "58", label: "58 mm roll" },
            ]}
            onChange={(e) => {
              edit(() => {
                setPaper(e.target.value as "58" | "80");
              });
            }}
          />
          <TextField
            label="Invoice prefix"
            value={prefix}
            maxLength={8}
            help="Printed before the sale number, like INV-."
            onChange={(e) => {
              edit(() => {
                setPrefix(e.target.value.toUpperCase());
              });
            }}
          />
        </div>
        <TextField
          label="Footer line"
          value={footer}
          maxLength={200}
          onChange={(e) => {
            edit(() => {
              setFooter(e.target.value);
            });
          }}
        />

        <h2>Layout</h2>
        <ol className={s.list} aria-label="Receipt blocks, top to bottom">
          {blocks.map((b, i) => (
            <li
              key={`${b.type}-${String(i)}`}
              style={{ listStyle: "none", marginLeft: "-1.25rem" }}
            >
              <div className={s.blockRow}>
                <div>
                  <strong>{label(b.type)}</strong>
                  {b.type === "text" ? (
                    <TextField
                      label="Text"
                      value={b.text ?? ""}
                      maxLength={200}
                      onChange={(e) => {
                        edit(() => {
                          setBlocks((cur) =>
                            cur.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                          );
                        });
                      }}
                    />
                  ) : null}
                </div>
                <Row>
                  <Button
                    variant="ghost"
                    style={TARGET}
                    disabled={i === 0}
                    aria-label={`Move ${label(b.type)} up`}
                    onClick={() => {
                      edit(() => {
                        setBlocks((cur) => moveBlock(cur, i, -1));
                      });
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    style={TARGET}
                    disabled={i === blocks.length - 1}
                    aria-label={`Move ${label(b.type)} down`}
                    onClick={() => {
                      edit(() => {
                        setBlocks((cur) => moveBlock(cur, i, 1));
                      });
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="ghost"
                    style={TARGET}
                    aria-label={`Remove ${label(b.type)}`}
                    onClick={() => {
                      edit(() => {
                        setBlocks((cur) => cur.filter((_, j) => j !== i));
                      });
                    }}
                  >
                    ✕
                  </Button>
                </Row>
              </div>
            </li>
          ))}
        </ol>
        <Row>
          <SelectField
            label="Add a block"
            value={add}
            options={BLOCKS.map((b) => ({ value: b.type, label: b.label }))}
            onChange={(e) => {
              setAdd(e.target.value as BlockType);
            }}
          />
          <Button
            variant="secondary"
            disabled={blocks.length >= 30}
            onClick={() => {
              edit(() => {
                setBlocks((cur) => [
                  ...cur,
                  { type: add, ...(add === "text" ? { text: "" } : {}) },
                ]);
              });
            }}
          >
            Add
          </Button>
        </Row>

        {problems.length === 0 ? null : (
          <Alert tone="danger">
            <ul className={s.list}>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        )}
        <div className={s.stickybar}>
          <Row spread>
            <span />
            <Button busy={busy} disabled={problems.length > 0} onClick={() => void save()}>
              Save receipt
            </Button>
          </Row>
        </div>
      </Stack>

      <Stack>
        <h2>Preview</h2>
        <pre
          className={s.paper}
          role="region"
          aria-label={`Receipt preview, ${paper} mm`}
          tabIndex={0}
        >
          {lines.join("\n")}
        </pre>
        <p>Sample sale. Your real receipts use the same layout.</p>
      </Stack>
    </div>
  );
}
