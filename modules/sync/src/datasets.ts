/** The datasets a terminal pulls (offline-sync.md). Producers without a module yet are added as they ship. */
export const DATASETS = ["catalog", "prices", "tax", "promotions", "stock_branch"] as const;
export type Dataset = (typeof DATASETS)[number];
export const isDataset = (s: string): s is Dataset => (DATASETS as readonly string[]).includes(s);
