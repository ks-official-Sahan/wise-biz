/** Navigation and command registry: one list feeds the sidebar, bottom nav and the command palette. */
export interface NavItem {
  readonly href:
    | "/"
    | "/catalog"
    | "/pricing"
    | "/sales"
    | "/shifts"
    | "/devices"
    | "/stock"
    | "/people"
    | "/roles"
    | "/audit"
    | "/settings";
  readonly label: string;
  /** Extra words the command palette matches on. */
  readonly keywords: readonly string[];
  /** Shown in the phone bottom bar (max 5). */
  readonly primary: boolean;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Home", keywords: ["dashboard", "overview"], primary: true },
  {
    href: "/catalog",
    label: "Products",
    keywords: ["catalog", "items", "sku", "barcode", "import", "inventory"],
    primary: true,
  },
  {
    href: "/sales",
    label: "Sales",
    keywords: ["receipts", "orders", "transactions", "voids", "returns", "refunds"],
    primary: true,
  },
  {
    href: "/shifts",
    label: "Shifts",
    keywords: ["z-report", "cash", "drawer", "till", "over short", "close"],
    primary: false,
  },
  {
    href: "/devices",
    label: "Terminals",
    keywords: ["devices", "pos", "enroll", "revoke", "suspend", "register"],
    primary: false,
  },
  {
    href: "/stock",
    label: "Stock",
    keywords: ["inventory", "receive", "adjust", "low stock", "expiry", "labels", "barcode"],
    primary: false,
  },
  {
    href: "/pricing",
    label: "Pricing",
    keywords: ["prices", "price list", "tax", "promotions", "discounts", "coupons", "fees"],
    primary: false,
  },
  {
    href: "/people",
    label: "People",
    keywords: ["members", "staff", "invite", "team"],
    primary: false,
  },
  { href: "/roles", label: "Roles", keywords: ["permissions", "access"], primary: false },
  {
    href: "/audit",
    label: "Audit log",
    keywords: ["history", "activity", "changes"],
    primary: true,
  },
  {
    href: "/settings",
    label: "Settings",
    keywords: ["business", "branches", "locations", "profile"],
    primary: true,
  },
];

export interface Command {
  readonly id: string;
  readonly label: string;
  readonly keywords: readonly string[];
  readonly href: string;
}

export const COMMANDS: readonly Command[] = [
  ...NAV.map((n) => ({
    id: `nav:${n.href}`,
    label: `Go to ${n.label}`,
    keywords: n.keywords,
    href: n.href,
  })),
  {
    id: "act:invite",
    label: "Invite a person",
    keywords: ["add", "member", "staff"],
    href: "/people?invite=1",
  },
  {
    id: "act:branch",
    label: "Add a branch",
    keywords: ["store", "shop", "warehouse"],
    href: "/settings?tab=branches&new=1",
  },
  {
    id: "act:product",
    label: "Add a product",
    keywords: ["new", "item", "sku"],
    href: "/catalog/new",
  },
  {
    id: "act:import",
    label: "Import products from a CSV",
    keywords: ["upload", "spreadsheet", "excel"],
    href: "/catalog/import",
  },
  {
    id: "act:receive",
    label: "Receive stock",
    keywords: ["delivery", "supplier", "goods in"],
    href: "/stock",
  },
  {
    id: "act:labels",
    label: "Print labels",
    keywords: ["barcode", "shelf", "zpl", "sticker"],
    href: "/stock/labels",
  },
  { id: "act:role", label: "Create a role", keywords: ["permission"], href: "/roles?new=1" },
  {
    id: "act:export",
    label: "Export the audit log",
    keywords: ["csv", "download"],
    href: "/audit?export=1",
  },
];

/** Case-insensitive match on label and keywords; every word of the query must hit. Pure, so it is unit-tested. */
export function filterCommands(query: string, commands: readonly Command[] = COMMANDS): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  return commands.filter((c) => {
    const hay = `${c.label} ${c.keywords.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
