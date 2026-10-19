export type DeviceClass = "pos" | "desktop" | "mobile" | "kiosk" | "web";
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type TimeWindow = Readonly<{
  /** Branch-local minutes since midnight, 0..1439. */
  startMinute: number;
  /** Exclusive. `end < start` means the window crosses midnight; `end === start` is empty. */
  endMinute: number;
  /** Days the window STARTS on. Omitted = every day. */
  days?: readonly DayOfWeek[];
}>;

export type Conditions = Readonly<{
  maxAmountMinor?: number;
  maxDiscountBps?: number;
  timeWindow?: TimeWindow;
  deviceClass?: readonly DeviceClass[];
  requiresOpenShift?: boolean;
}>;

export type DecisionContext = Readonly<{
  tenantId: string;
  roles: readonly string[];
  branchScope: "all" | readonly string[];
  /** Epoch ms. Passed in, never read from a clock. */
  now: number;
  localMinuteOfDay: number;
  localDayOfWeek: DayOfWeek;
  deviceClass?: DeviceClass;
  shiftOpen?: boolean;
}>;

export type Resource = Readonly<{
  tenantId: string;
  branchId?: string;
  amountMinor?: number;
  discountBps?: number;
}>;

export type ConditionReason =
  | "amount_exceeds_limit"
  | "discount_exceeds_limit"
  | "outside_time_window"
  | "device_class_not_allowed"
  | "shift_not_open";

const DEVICES: ReadonlySet<string> = new Set(["pos", "desktop", "mobile", "kiosk", "web"]);
const nonNegInt = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const minute = (n: unknown): n is number => nonNegInt(n) && n < 1440;

/** Structural check, used when loading rows or snapshots. Invalid conditions must never become grants. */
export function isValidConditions(value: unknown): value is Conditions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.maxAmountMinor !== undefined && !nonNegInt(c.maxAmountMinor)) return false;
  if (c.maxDiscountBps !== undefined && !nonNegInt(c.maxDiscountBps)) return false;
  if (c.requiresOpenShift !== undefined && typeof c.requiresOpenShift !== "boolean") return false;
  const devices = c.deviceClass;
  if (devices !== undefined) {
    if (
      !Array.isArray(devices) ||
      devices.length === 0 ||
      !devices.every((d) => DEVICES.has(d as string))
    )
      return false;
  }
  const w = c.timeWindow;
  if (w !== undefined) {
    if (typeof w !== "object" || w === null) return false;
    const tw = w as Record<string, unknown>;
    if (!minute(tw.startMinute) || !minute(tw.endMinute)) return false;
    const days = tw.days;
    if (
      days !== undefined &&
      (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    ) {
      return false;
    }
  }
  return true;
}

function inWindow(w: TimeWindow, ctx: DecisionContext): boolean {
  const { startMinute: s, endMinute: e } = w;
  const m = ctx.localMinuteOfDay;
  const overnight = s > e;
  const inside = overnight ? m >= s || m < e : m >= s && m < e;
  if (!inside) return false;
  if (w.days === undefined) return true;
  // After midnight the window still belongs to the day it started on.
  const startDay = overnight && m < e ? (ctx.localDayOfWeek + 6) % 7 : ctx.localDayOfWeek;
  return w.days.includes(startDay as DayOfWeek);
}

/** First failing condition's reason, or undefined when all pass. Missing inputs fail closed. */
export function firstFailure(
  conditions: Conditions | undefined,
  ctx: DecisionContext,
  resource: Resource,
): ConditionReason | undefined {
  if (conditions === undefined) return undefined;
  const { maxAmountMinor, maxDiscountBps, timeWindow, deviceClass, requiresOpenShift } = conditions;
  if (
    maxAmountMinor !== undefined &&
    !(resource.amountMinor !== undefined && resource.amountMinor <= maxAmountMinor)
  ) {
    return "amount_exceeds_limit";
  }
  if (
    maxDiscountBps !== undefined &&
    !(resource.discountBps !== undefined && resource.discountBps <= maxDiscountBps)
  ) {
    return "discount_exceeds_limit";
  }
  if (timeWindow !== undefined && !inWindow(timeWindow, ctx)) return "outside_time_window";
  if (
    deviceClass !== undefined &&
    !(ctx.deviceClass !== undefined && deviceClass.includes(ctx.deviceClass))
  ) {
    return "device_class_not_allowed";
  }
  if (requiresOpenShift === true && ctx.shiftOpen !== true) return "shift_not_open";
  return undefined;
}
