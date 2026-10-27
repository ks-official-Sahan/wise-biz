"use client";

import { forwardRef, useEffect, useId, useRef } from "react";

import s from "./ui.module.css";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  readonly variant?: Variant;
  readonly busy?: boolean;
  /** Stays focusable and announces aria-disabled (ui-principles: disabled controls stay discoverable). */
  readonly disabled?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    busy = false,
    disabled = false,
    className,
    onClick,
    children,
    type,
    ...rest
  },
  ref,
) {
  const inert = disabled || busy;
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={[s.button, s[variant], className].filter(Boolean).join(" ")}
      aria-disabled={inert || undefined}
      aria-busy={busy || undefined}
      onClick={(e) => {
        if (inert) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </button>
  );
});

interface FieldShell {
  readonly label: string;
  readonly help?: string | undefined;
  readonly error?: string | undefined;
}

function Shell({
  id,
  label,
  help,
  error,
  children,
}: FieldShell & { readonly id: string; readonly children: ReactNode }) {
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor={id}>
        {label}
      </label>
      {children}
      {help !== undefined && error === undefined ? (
        <p id={`${id}-help`} className={s.help}>
          {help}
        </p>
      ) : null}
      <div aria-live="polite">
        {error === undefined ? null : (
          <p id={`${id}-error`} className={s.error}>
            <span aria-hidden>!</span>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** Joins class names, skipping empty ones (CSS module lookups are typed `string | undefined`). */
export const cx = (...names: (string | false | null | undefined)[]): string =>
  names.filter(Boolean).join(" ");

const describedBy = (id: string, help?: string, error?: string): string | undefined =>
  error !== undefined ? `${id}-error` : help !== undefined ? `${id}-help` : undefined;

export type TextFieldProps = FieldShell & Omit<InputHTMLAttributes<HTMLInputElement>, "id">;

export function TextField({ label, help, error, required, ...input }: TextFieldProps) {
  const id = useId();
  return (
    <Shell id={id} label={required ? `${label} (required)` : label} help={help} error={error}>
      <input
        id={id}
        className={s.input}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, help, error)}
        required={required}
        {...input}
      />
    </Shell>
  );
}

export type SelectFieldProps = FieldShell &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & {
    readonly options: readonly { readonly value: string; readonly label: string }[];
  };

export function SelectField({ label, help, error, options, ...select }: SelectFieldProps) {
  const id = useId();
  return (
    <Shell id={id} label={label} help={help} error={error}>
      <select
        id={id}
        className={s.input}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy(id, help, error)}
        {...select}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Shell>
  );
}

export function Card({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <section className={[s.card, className].filter(Boolean).join(" ")}>{children}</section>;
}

export function Stack({ children }: { readonly children: ReactNode }) {
  return <div className={s.stack}>{children}</div>;
}

export function Row({
  children,
  spread = false,
}: {
  readonly children: ReactNode;
  readonly spread?: boolean;
}) {
  return <div className={spread ? s.spread : s.row}>{children}</div>;
}

export function Alert({
  tone,
  children,
}: {
  readonly tone: "danger" | "success" | "info";
  readonly children: ReactNode;
}) {
  const cls = tone === "danger" ? s.alertDanger : tone === "success" ? s.alertSuccess : s.alertInfo;
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx(s.alert, cls)}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "accent" | "warning";
}) {
  const cls = tone === "accent" ? s.badgeAccent : tone === "warning" ? s.badgeWarning : "";
  return <span className={cx(s.badge, cls)}>{children}</span>;
}

export function Skeleton({ width, height }: { readonly width: string; readonly height: number }) {
  return <span aria-hidden className={s.skeleton} style={{ width, height }} />;
}

/** Loading placeholder with the final shape, announced once as busy. */
export function SkeletonRows({
  rows = 5,
  label,
}: {
  readonly rows?: number;
  readonly label: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={s.stack}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} width={`${String(92 - ((i * 13) % 30))}%`} height={20} />
      ))}
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className={s.empty}>
      <h3>{title}</h3>
      {children === undefined ? null : <p className={s.muted}>{children}</p>}
      {action}
    </div>
  );
}

/** Error state: what happened and how to recover. */
export function ErrorState({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <Alert tone="danger">
      <div className={s.spread}>
        <span>Could not load this. {message}</span>
        {onRetry === undefined ? null : (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </Alert>
  );
}

/**
 * Native <dialog> modal: the browser provides focus trap, Escape, inert background and focus return. Title is the
 * accessible name; the close button is always visible (WCAG 3.2.4 / ui-principles).
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  side = false,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  /** Right-hand drawer instead of a centered dialog. */
  readonly side?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={side ? s.drawer : s.dialog}
      onClose={onClose}
      onClick={(e) => {
        // Backdrop click: the event target is the dialog element itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={s.stack}>
        <div className={s.spread}>
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export { s as styles };
