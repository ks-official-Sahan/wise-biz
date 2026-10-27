/**
 * Permission matrix copy for the roles editor, grouped by module, with what each grant allows in plain words. New
 * modules add their rows here when they ship permissions (the API catalog is the authority; unknown grants still
 * display, with their raw name).
 */
export interface PermissionInfo {
  readonly permission: string;
  readonly label: string;
  readonly allows: string;
}

export const PERMISSION_GROUPS: readonly { module: string; items: readonly PermissionInfo[] }[] = [
  {
    module: "Business and people",
    items: [
      {
        permission: "tenancy:read",
        label: "View business",
        allows: "See branches, locations, people and roles.",
      },
      {
        permission: "tenancy:manage",
        label: "Manage business",
        allows:
          "Invite people, change their roles and edit branches, locations and the business profile.",
      },
    ],
  },
  {
    module: "Audit log",
    items: [
      {
        permission: "audit:read",
        label: "View audit log",
        allows: "See who changed what, with before and after.",
      },
      {
        permission: "audit:export",
        label: "Export audit log",
        allows: "Download the audit log as CSV. Each export is itself recorded.",
      },
    ],
  },
];

export const KNOWN_PERMISSIONS = new Set(
  PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.permission)),
);

/** Grants added and removed between two sets, for the "review before save" summary. Pure. */
export function diffGrants(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  return {
    added: [...after].filter((p) => !before.has(p)).sort(),
    removed: [...before].filter((p) => !after.has(p)).sort(),
  };
}
