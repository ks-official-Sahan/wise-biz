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
    module: "Products",
    items: [
      {
        permission: "catalog:read",
        label: "View products",
        allows: "See products, variants, barcodes, categories and tags.",
      },
      {
        permission: "catalog:write",
        label: "Edit products",
        allows: "Create and change products, import spreadsheets, archive and restore.",
      },
    ],
  },
  {
    module: "Sales",
    items: [
      { permission: "sales:read", label: "View sales", allows: "See sales, shifts and Z-reports." },
      {
        permission: "sales:return",
        label: "Take returns",
        allows: "Refund sold items at the till.",
      },
      { permission: "sales:void", label: "Void sales", allows: "Void a recent sale at the till." },
    ],
  },
  {
    module: "Terminals",
    items: [
      {
        permission: "devices:read",
        label: "View terminals",
        allows: "See terminals and when they were last online.",
      },
      {
        permission: "devices:manage",
        label: "Manage terminals",
        allows: "Add, rename, move, suspend, revoke or blacklist terminals.",
      },
    ],
  },
  {
    module: "Branding",
    items: [
      {
        permission: "theming:read",
        label: "View branding",
        allows: "See the theme and receipt layout.",
      },
      {
        permission: "theming:write",
        label: "Edit branding",
        allows: "Change colours, fonts and the receipt, and publish them to every terminal.",
      },
    ],
  },
  {
    module: "Stock",
    items: [
      {
        permission: "inventory:read",
        label: "View stock",
        allows: "See stock on hand, batches, low stock and expiry.",
      },
      {
        permission: "inventory:receive",
        label: "Receive stock",
        allows: "Record deliveries with cost, lot and expiry.",
      },
      {
        permission: "inventory:adjust",
        label: "Adjust stock",
        allows: "Correct stock for damage, loss or counts. Large adjustments may need approval.",
      },
      {
        permission: "inventory:write",
        label: "Edit stock settings",
        allows: "Set low-stock minimums and batch sale prices.",
      },
    ],
  },
  {
    module: "Pricing",
    items: [
      {
        permission: "pricing:read",
        label: "View pricing",
        allows: "See price lists, tax regions, fees and promotions.",
      },
      {
        permission: "pricing:write",
        label: "Edit pricing",
        allows: "Change prices, tax, fees and promotions, and publish promotions.",
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
