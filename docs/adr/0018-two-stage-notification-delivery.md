# ADR 0018: Notifications are stored and flagged in the event transaction, and sent by a separate leased loop

Status: accepted · 2026-11-04

## Context
The notifications consumer stored in-app notifications and then sent the emails and phone pushes inside the bus transaction (the consumer runs in `ctx.client`). A send is a side effect a rollback cannot undo. If a later step failed, or the event was retried after some sends, people received the same email or push again: `emailed_at` and `pushed_at` were written in the transaction that rolled back.

## Decision
- **Stage 1, the consumer.** In the event's transaction it stores the notifications and flags what each needs (`email_pending`, `push_pending`, set once through `delivery_marked_at`), from the person's preferences and registered phones. It sends nothing.
- **Stage 2, a worker loop** (`notifications-delivery`, every 10 s, `runDeliveries`). It finds businesses with flagged rows through a SELECT-only `wb_worker` policy (the ADR 0013 pattern), then per business, in a short transaction, claims rows with `FOR UPDATE SKIP LOCKED` and a 2-minute lease and counts the attempt. Businesses are served oldest due row first, so none is starved. It sends outside any transaction and marks each email right after its own send, and each group of pushes (up to one push request) right after that group. Each send has a timeout (10 s). The worker stops sending once a send could outlive the lease; the unsent rows are claimed again after it. Dead phone tokens are removed.
- A failed send is logged (with the business id) and the row is claimed again after the lease. After 5 claims a row is given up, so a bad address cannot be retried forever.
- A worker that has no mail port (or no push port) leaves that channel's rows pending; it never marks a message it did not send.
- Several worker replicas can run the loop at once; the lease and `SKIP LOCKED` keep a row with one of them.

## Consequences
- Delivery is bounded retry, not a guarantee: a send that fails 5 times is dropped (the row stays visible in the app, only the email or push is lost). Within those attempts it is at least once, with a window of one message (one push group for pushes): a crash between a send and its mark repeats that message after the lease. Removing that needs provider idempotency keys, which SMTP and Expo push do not offer. This replaces the earlier window of a whole event.
- A rollback of the event leaves nothing sent and nothing flagged. A failing address no longer causes the others to be sent again.
- Email and push now arrive within about 10 seconds of the event, not in the same instant.
- A compromised worker can read the flagged notifications of every business. It already reads each business's events, which carry the same data.
