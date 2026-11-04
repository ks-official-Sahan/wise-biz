"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  Alert,
  Badge,
  Button,
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
  BODY_FONT_OPTIONS,
  NUMERIC_FONT_OPTIONS,
  applyFix,
  brandingKeys,
  cleanHex,
  describeIssue,
  previewOf,
  previewVars,
  seedText,
  startingInput,
  useThemeState,
  useThemeVersions,
} from "@/lib/branding.ts";
import { useTenant } from "@/lib/tenant.tsx";

import s from "./branding.module.css";

import type { ThemeInput } from "@wise-biz/theme";

type ModeChoice = "both-light" | "both-dark" | "light" | "dark";

function modeChoice(i: ThemeInput): ModeChoice {
  if (i.modes.available.length === 2)
    return i.modes.default === "light" ? "both-light" : "both-dark";
  return i.modes.default;
}
function withModes(i: ThemeInput, c: ModeChoice): ThemeInput {
  const modes: ThemeInput["modes"] =
    c === "both-light"
      ? { available: ["light", "dark"], default: "light" }
      : c === "both-dark"
        ? { available: ["light", "dark"], default: "dark" }
        : c === "light"
          ? { available: ["light"], default: "light" }
          : { available: ["dark"], default: "dark" };
  // An override for a mode that is no longer available would be refused: drop it with the mode.
  const keep = (m: "light" | "dark") => (modes.available as readonly string[]).includes(m);
  const overrides = {
    ...(keep("light") && i.overrides?.light !== undefined ? { light: i.overrides.light } : {}),
    ...(keep("dark") && i.overrides?.dark !== undefined ? { dark: i.overrides.dark } : {}),
  };
  return {
    version: i.version,
    name: i.name,
    modes,
    brand: i.brand,
    font: i.font,
    density: i.density,
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
  };
}

export function ThemeEditor() {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const state = useThemeState(t);
  const versions = useThemeVersions(t);
  // Kept here: the editor remounts on every new draft or publish, and the message must survive that.
  const [notice, setNotice] = useState<string | null>(null);
  if (state.isPending) return <SkeletonRows label="Loading theme" />;
  if (state.isError)
    return (
      <ErrorState
        error={state.error}
        onRetry={() => {
          void state.refetch();
        }}
      />
    );
  return (
    <Editor
      // A new draft or publish from the server resets the form to what is stored.
      key={`${state.data.draft?.id ?? "none"}:${state.data.published?.id ?? "none"}:${JSON.stringify(state.data.draft?.input ?? null)}`}
      initial={startingInput(state.data)}
      hasDraft={state.data.draft !== null}
      liveVersion={state.data.published?.version ?? null}
      versions={versions.data ?? []}
      notice={notice}
      onNotice={setNotice}
    />
  );
}

function Editor({
  initial,
  hasDraft,
  liveVersion,
  versions,
  notice,
  onNotice,
}: {
  notice: string | null;
  onNotice: (message: string | null) => void;
  initial: ThemeInput;
  hasDraft: boolean;
  liveVersion: number | null;
  versions: readonly {
    id: string;
    version: number | null;
    name: string;
    status: string;
    publishedAt: string | null;
  }[];
}) {
  const { tenant } = useTenant();
  const t = tenant.tenantId;
  const qc = useQueryClient();
  const [input, setInput] = useState<ThemeInput>(initial);
  const [previewMode, setPreviewMode] = useState<"light" | "dark">(initial.modes.default);
  const [seedDraft, setSeedDraft] = useState(seedText(initial.brand.seed));
  const [darkSeedDraft, setDarkSeedDraft] = useState(
    seedText(initial.overrides?.dark?.seed ?? initial.brand.seed),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = previewOf(input);
  const dirty = JSON.stringify(input) !== JSON.stringify(initial);
  const shownMode = (input.modes.available as readonly string[]).includes(previewMode)
    ? previewMode
    : input.modes.default;
  const set = (next: ThemeInput) => {
    onNotice(null);
    setInput(next);
  };

  async function refresh(): Promise<void> {
    await Promise.all([
      qc.invalidateQueries({ queryKey: brandingKeys.theme(t) }),
      qc.invalidateQueries({ queryKey: brandingKeys.versions(t) }),
    ]);
  }
  async function save(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/v1/theming/theme/draft", { body: { input } });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function onSave(): Promise<void> {
    if (!(await save())) return;
    onNotice("Draft saved. Terminals keep the live theme until you publish.");
    await refresh();
  }
  async function onPublish(): Promise<void> {
    if (dirty || !hasDraft) if (!(await save())) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/theming/theme/publish", { body: {} });
      onNotice("Published. Terminals pick it up within seconds.");
      await refresh();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 422
          ? "The theme fails the contrast checks. Fix the items listed, then publish."
          : e instanceof Error
            ? e.message
            : "Publishing failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function restore(version: number): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/v1/theming/theme/restore", { body: { version } });
      onNotice(
        `Version ${String(version)} is now your draft. Review it, then publish to roll back.`,
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore that version.");
    } finally {
      setBusy(false);
    }
  }

  const blocked = preview.error !== null || preview.issues.length > 0;

  return (
    <div className={s.split}>
      <Stack>
        {error === null ? null : <Alert tone="danger">{error}</Alert>}
        {notice === null ? null : <Alert tone="success">{notice}</Alert>}
        <p className={styles.muted}>
          {liveVersion === null
            ? "Nothing is published yet: terminals use the standard look."
            : `Live: version ${String(liveVersion)}.`}
        </p>
        <TextField
          label="Theme name"
          value={input.name}
          onChange={(e) => {
            set({ ...input, name: e.target.value });
          }}
        />
        <div className={s.colorRow}>
          <input
            type="color"
            aria-label="Pick the brand colour"
            value={cleanHex(seedDraft) ?? "#0e7c66"}
            onChange={(e) => {
              setSeedDraft(e.target.value);
              set({ ...input, brand: { seed: e.target.value } });
            }}
          />
          <TextField
            label="Brand colour"
            value={seedDraft}
            help="Buttons, links and highlights. #rrggbb."
            error={cleanHex(seedDraft) === null ? "Enter a colour like #0e7c66." : undefined}
            onChange={(e) => {
              setSeedDraft(e.target.value);
              const hex = cleanHex(e.target.value);
              if (hex !== null) set({ ...input, brand: { seed: hex } });
            }}
          />
        </div>
        <div className={s.grid}>
          <SelectField
            label="Modes"
            value={modeChoice(input)}
            options={[
              { value: "both-light", label: "Light and dark, starts light" },
              { value: "both-dark", label: "Light and dark, starts dark" },
              { value: "light", label: "Light only" },
              { value: "dark", label: "Dark only" },
            ]}
            onChange={(e) => {
              set(withModes(input, e.target.value as ModeChoice));
            }}
          />
          <SelectField
            label="Density"
            value={input.density}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
            onChange={(e) => {
              set({ ...input, density: e.target.value as ThemeInput["density"] });
            }}
          />
          <SelectField
            label="Text font"
            value={input.font.body}
            options={BODY_FONT_OPTIONS}
            onChange={(e) => {
              set({
                ...input,
                font: { ...input.font, body: e.target.value as ThemeInput["font"]["body"] },
              });
            }}
          />
          <SelectField
            label="Numbers font"
            value={input.font.numeric}
            options={NUMERIC_FONT_OPTIONS}
            onChange={(e) => {
              set({
                ...input,
                font: { ...input.font, numeric: e.target.value as ThemeInput["font"]["numeric"] },
              });
            }}
          />
        </div>
        {(input.modes.available as readonly string[]).includes("dark") ? (
          <TextField
            label="Dark mode brand colour (optional)"
            value={darkSeedDraft}
            help="A lighter shade often reads better on dark backgrounds."
            error={cleanHex(darkSeedDraft) === null ? "Enter a colour like #c98a12." : undefined}
            onChange={(e) => {
              setDarkSeedDraft(e.target.value);
              const hex = cleanHex(e.target.value);
              if (hex !== null)
                set({
                  ...input,
                  overrides: { ...input.overrides, dark: { ...input.overrides?.dark, seed: hex } },
                });
            }}
          />
        ) : null}

        {preview.error === null ? null : <Alert tone="danger">{preview.error}</Alert>}
        {preview.issues.length === 0 ? null : (
          <Alert tone="danger">
            <p>These colours are too hard to read. Fix them to publish.</p>
            <ul className={s.list}>
              {preview.issues.map((i) => {
                const fixed = applyFix(input, i);
                return (
                  <li key={`${i.mode}-${i.fg}-${i.bg}`}>
                    {describeIssue(i)}{" "}
                    {fixed === null ? (
                      <span>Try a different brand colour.</span>
                    ) : (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          set(fixed);
                        }}
                      >
                        Use the suggested colour
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Alert>
        )}

        <div className={s.stickybar}>
          <Row spread>
            <span role="status">{dirty ? "Unsaved changes." : hasDraft ? "Draft saved." : ""}</span>
            <Row>
              <Button
                variant="secondary"
                busy={busy}
                disabled={!dirty}
                onClick={() => void onSave()}
              >
                Save draft
              </Button>
              <Button
                busy={busy}
                disabled={blocked || (!dirty && !hasDraft)}
                onClick={() => void onPublish()}
              >
                Publish
              </Button>
            </Row>
          </Row>
        </div>

        <h2>History</h2>
        {versions.length === 0 ? (
          <p className={styles.muted}>Published versions appear here.</p>
        ) : (
          <ul className={s.list}>
            {versions.map((v) => {
              const number = v.version;
              return (
                <li key={v.id}>
                  {number === null ? `Draft: ${v.name}` : `Version ${String(number)}: ${v.name}`}{" "}
                  {v.status === "published" ? (
                    <Badge tone="accent">Live</Badge>
                  ) : number === null ? (
                    <Badge>Draft</Badge>
                  ) : (
                    <Button variant="ghost" disabled={busy} onClick={() => void restore(number)}>
                      {`Use version ${String(number)} as draft`}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Stack>

      <Stack>
        <Row spread>
          <h2>Preview</h2>
          {input.modes.available.length === 2 ? (
            <SelectField
              label="Mode"
              value={shownMode}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
              onChange={(e) => {
                setPreviewMode(e.target.value as "light" | "dark");
              }}
            />
          ) : null}
        </Row>
        {preview.resolved === null ? null : (
          <div
            className={s.preview}
            style={previewVars(preview.resolved, shownMode)}
            aria-label="Theme preview"
            role="group"
          >
            <div className={s.pvCard}>
              <strong>{tenant.name}</strong>
              <span className={s.pvMuted}>Sell screen</span>
              <div>
                <span>Flat white × 2</span> <strong>9.00</strong>
              </div>
              <div>
                <span>Almond croissant</span> <strong>4.50</strong>
              </div>
              <button type="button" className={s.pvButton} tabIndex={-1}>
                Charge 13.50
              </button>
            </div>
            <div className={s.pvCard}>
              <span className={s.pvChip}>New</span>
              <strong>Storefront card</strong>
              <span className={s.pvMuted}>Fresh every morning</span>
              <span className={s.pvDanger}>Only 2 left</span>
            </div>
          </div>
        )}
      </Stack>
    </div>
  );
}
