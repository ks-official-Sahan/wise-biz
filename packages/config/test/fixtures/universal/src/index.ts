import { readFileSync } from "fs";
import { readFile } from "node:fs";

export const data: unknown = [readFileSync, readFile];
export const loose: any = 1;

async function work(): Promise<number> {
  return 1;
}

work();
export const lazyOs = import("node:os");
