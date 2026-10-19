/** Thrown on invalid env. Carries key names and issue kinds only, never values. */
export class EnvError extends Error {
  readonly keys: readonly string[];

  constructor(problems: ReadonlyMap<string, string>) {
    const keys = [...problems.keys()].sort();
    const lines = keys.map((key) => `  - ${key}: ${problems.get(key) ?? "invalid"}`);
    super(`Invalid environment:\n${lines.join("\n")}`);
    this.name = "EnvError";
    this.keys = Object.freeze(keys);
  }
}
