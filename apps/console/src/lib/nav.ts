/** Navigation and command registry: one list feeds the sidebar, bottom nav and the command palette. */
export interface NavItem {
  readonly href: "/" | "/people" | "/roles" | "/audit" | "/settings";
  readonly label: string;
  /** Extra words the command palette matches on. */
  readonly keywords: readonly string[];
  /** Shown in the phone bottom bar (max 5). */
  readonly primary: boolean;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Home", keywords: ["dashboard", "overview"], primary: true },
  {
    href: "/people",
    label: "People",
    keywords: ["members", "staff", "invite", "team"],
    primary: true,
  },
  { href: "/roles", label: "Roles", keywords: ["permissions", "access"], primary: true },
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
