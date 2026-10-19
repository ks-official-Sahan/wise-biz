// Minimal typing for Vite's import.meta.glob (used by the snapshot test only).
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { query: string; import: string; eager: true },
  ): Record<string, T>;
}
