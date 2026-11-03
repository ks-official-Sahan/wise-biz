/** What a person can be told about. The preferences screen lists exactly these. */
export const KINDS = [
  { kind: "low_stock", label: "Low stock", permission: "inventory:read" },
  { kind: "expiring", label: "Stock about to expire", permission: "inventory:read" },
  { kind: "export_ready", label: "A report export is ready", permission: "reporting:read" },
  { kind: "device_offline", label: "A terminal went offline", permission: "devices:read" },
  { kind: "daily_summary", label: "Daily sales summary", permission: "reporting:read" },
] as const;

export type Kind = (typeof KINDS)[number]["kind"];
export const KIND_IDS = KINDS.map((k) => k.kind) as [Kind, ...Kind[]];
