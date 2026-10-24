import { isCurrency } from "@wise-biz/money";

import { BRANCH_KINDS, CUTOFF_RE, fail, isIanaTimezone, NAME_MAX, text } from "./business.ts";

import type { BranchKind } from "./business.ts";

export const LOCATION_KINDS = ["sales_floor", "backroom", "warehouse"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

const COUNTRY_RE = /^[A-Z]{2}$/;
const TAX_REGION_MAX = 32;

/** Business defaults. null = not set yet (a tenant fresh from sign-up). */
export interface ProfilePatch {
  readonly name?: string | undefined;
  readonly country?: string | null | undefined;
  readonly currency?: string | null | undefined;
  readonly timezone?: string | null | undefined;
  readonly taxRegion?: string | null | undefined;
}

/** Pure: trims and validates only the fields present. Throws VALIDATION_FAILED with a field path. */
export interface NormalisedProfilePatch {
  name?: string;
  country?: string | null;
  currency?: string | null;
  timezone?: string | null;
  taxRegion?: string | null;
}

export function normaliseProfilePatch(input: ProfilePatch): NormalisedProfilePatch {
  const out: NormalisedProfilePatch = {};
  if (input.name !== undefined) out.name = text("name", input.name, NAME_MAX);
  if (input.country !== undefined) {
    const v = input.country === null ? null : input.country.trim().toUpperCase();
    if (v !== null && !COUNTRY_RE.test(v)) fail("country", "must be an ISO 3166-1 alpha-2 code");
    out.country = v;
  }
  if (input.currency !== undefined) {
    const v = input.currency === null ? null : input.currency.trim().toUpperCase();
    if (v !== null && !isCurrency(v)) fail("currency", "must be an ISO 4217 currency");
    out.currency = v;
  }
  if (input.timezone !== undefined) {
    if (input.timezone !== null && !isIanaTimezone(input.timezone)) {
      fail("timezone", "must be an IANA time zone");
    }
    out.timezone = input.timezone;
  }
  if (input.taxRegion !== undefined) {
    out.taxRegion =
      input.taxRegion === null ? null : text("taxRegion", input.taxRegion, TAX_REGION_MAX);
  }
  if (Object.keys(out).length === 0) fail("body", "nothing to change");
  return out;
}

/** True once the profile can drive checkout defaults: the onboarding wizard refuses to finish before this. */
export function profileComplete(p: {
  country: string | null;
  currency: string | null;
  timezone: string | null;
  taxRegion: string | null;
}): boolean {
  return p.country !== null && p.currency !== null && p.timezone !== null && p.taxRegion !== null;
}

export interface BranchFields {
  readonly name: string;
  readonly kind: BranchKind;
  readonly timezone: string;
  readonly currency: string;
  readonly taxRegion: string;
  readonly businessDayCutoff: string;
}

/** Pure: validates a full branch (create) or the present fields of a patch (update). */
export function normaliseBranch(
  input: { readonly [K in keyof BranchFields]?: string | undefined },
  mode: "create" | "patch",
): Partial<BranchFields> {
  const out: { -readonly [K in keyof BranchFields]?: BranchFields[K] } = {};
  const need = (key: keyof BranchFields): string | undefined => {
    const v = input[key];
    if (v === undefined && mode === "create" && key !== "businessDayCutoff") fail(key, "required");
    return v;
  };
  const name = need("name");
  if (name !== undefined) out.name = text("name", name, NAME_MAX);
  const kind = need("kind");
  if (kind !== undefined) {
    if (!(BRANCH_KINDS as readonly string[]).includes(kind)) fail("kind", "unknown kind");
    out.kind = kind as BranchKind;
  }
  const timezone = need("timezone");
  if (timezone !== undefined) {
    if (!isIanaTimezone(timezone)) fail("timezone", "must be an IANA time zone");
    out.timezone = timezone;
  }
  const currency = need("currency");
  if (currency !== undefined) {
    const v = currency.trim().toUpperCase();
    if (!isCurrency(v)) fail("currency", "must be an ISO 4217 currency");
    out.currency = v;
  }
  const taxRegion = need("taxRegion");
  if (taxRegion !== undefined) out.taxRegion = text("taxRegion", taxRegion, TAX_REGION_MAX);
  const cutoff = input.businessDayCutoff ?? (mode === "create" ? "00:00" : undefined);
  if (cutoff !== undefined) {
    if (!CUTOFF_RE.test(cutoff)) fail("businessDayCutoff", "must be HH:MM");
    out.businessDayCutoff = cutoff;
  }
  if (mode === "patch" && Object.keys(out).length === 0) fail("body", "nothing to change");
  return out;
}

/** Pure: location name and kind. */
export function normaliseLocation(
  input: { name?: string | undefined; kind?: string | undefined },
  mode: "create" | "patch",
): { name?: string; kind?: LocationKind } {
  const out: { name?: string; kind?: LocationKind } = {};
  if (input.name === undefined && mode === "create") fail("name", "required");
  if (input.name !== undefined) out.name = text("name", input.name, NAME_MAX);
  const kind = input.kind ?? (mode === "create" ? "sales_floor" : undefined);
  if (kind !== undefined) {
    if (!(LOCATION_KINDS as readonly string[]).includes(kind)) fail("kind", "unknown kind");
    out.kind = kind as LocationKind;
  }
  if (mode === "patch" && Object.keys(out).length === 0) fail("body", "nothing to change");
  return out;
}
