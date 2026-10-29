import { uuidv7 } from "@wise-biz/ids";
import { createImportConsumer } from "@wise-biz/module-catalog";
import { createSearchProjectionConsumer } from "@wise-biz/module-search";
import { createInviteEmailConsumer } from "@wise-biz/module-tenancy";

import type { ConsumerDefinition } from "@wise-biz/events";
import type { ImportJobDeps } from "@wise-biz/module-catalog";
import type { MailSender } from "@wise-biz/module-tenancy";

export interface ConsumerDeps {
  /** Real mailer in production (@wise-biz/mailer), a capture mailer in tests. */
  readonly mailer: MailSender;
  readonly consoleUrl: string;
  readonly inviteSecret: string;
  /** Catalog import job (ADR 0012): the wb_worker pool, object storage, and where job failures are reported. */
  readonly imports: {
    readonly pool: ImportJobDeps["pool"];
    readonly store: ImportJobDeps["store"];
    readonly onError: (err: unknown, importId: string) => void;
  };
}

/**
 * Consumers run by this worker. Each module appends its own here as it ships. The invite-email consumer is built from
 * the deps the worker resolves from env (see worker.ts), so the mailer is never constructed at import time.
 */
export function createConsumers(deps: ConsumerDeps): readonly ConsumerDefinition[] {
  // Structural match: the module's consumer is a plain object with the ConsumerDefinition shape.
  return [
    createInviteEmailConsumer(deps),
    createSearchProjectionConsumer(),
    createImportConsumer(
      {
        pool: deps.imports.pool,
        store: deps.imports.store,
        ids: { uuidv7 },
        clock: { now: () => Date.now() },
      },
      deps.imports.onError,
    ),
  ];
}
