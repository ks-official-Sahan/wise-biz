import {
  authEnv,
  chainerEnv,
  consoleEnv,
  databaseEnv,
  demoSeedEnv,
  emailEnv,
  httpEnv,
  identityDbEnv,
  inviteEnv,
  pinEnv,
  kafkaEnv,
  mailEnv,
  observabilityEnv,
  redisEnv,
  storageEnv,
  webauthnEnv,
  workerEnv,
} from "./fragments.ts";

import type { z } from "zod";

export type EnvShape = Readonly<Record<string, z.ZodType>>;

export const ALL_ENV_FRAGMENTS = {
  database: databaseEnv,
  redis: redisEnv,
  kafka: kafkaEnv,
  auth: authEnv,
  storage: storageEnv,
  email: emailEnv,
  observability: observabilityEnv,
  http: httpEnv,
  worker: workerEnv,
  chainer: chainerEnv,
  identityDb: identityDbEnv,
  mail: mailEnv,
  invite: inviteEnv,
  pin: pinEnv,
  console: consoleEnv,
  webauthn: webauthnEnv,
  demoSeed: demoSeedEnv,
} as const satisfies Record<string, EnvShape>;

export interface EnvKeyInfo {
  readonly key: string;
  readonly fragment: string;
  readonly required: boolean;
}

/** Enumerate every key with its fragment; required = no default and not optional. */
export function envKeys(fragments: Readonly<Record<string, EnvShape>>): EnvKeyInfo[] {
  const out: EnvKeyInfo[] = [];
  for (const [fragment, shape] of Object.entries(fragments)) {
    for (const [key, schema] of Object.entries(shape)) {
      out.push({ key, fragment, required: !schema.safeParse(undefined).success });
    }
  }
  return out;
}
