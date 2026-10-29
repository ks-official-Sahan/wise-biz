import { createSearchProjectionConsumer } from "@wise-biz/module-search";
import { createInviteEmailConsumer } from "@wise-biz/module-tenancy";

import type { ConsumerDefinition } from "@wise-biz/events";
import type { MailSender } from "@wise-biz/module-tenancy";

export interface ConsumerDeps {
  /** Real mailer in production (@wise-biz/mailer), a capture mailer in tests. */
  readonly mailer: MailSender;
  readonly consoleUrl: string;
  readonly inviteSecret: string;
}

/**
 * Consumers run by this worker. Each module appends its own here as it ships. The invite-email consumer is built from
 * the deps the worker resolves from env (see worker.ts), so the mailer is never constructed at import time.
 */
export function createConsumers(deps: ConsumerDeps): readonly ConsumerDefinition[] {
  // Structural match: the module's consumer is a plain object with the ConsumerDefinition shape.
  return [createInviteEmailConsumer(deps), createSearchProjectionConsumer()];
}
