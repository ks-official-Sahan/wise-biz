/** True only for exactly "development" or "test". Absence or any other value is treated as production. */
export function isDevLike(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development" || nodeEnv === "test";
}
