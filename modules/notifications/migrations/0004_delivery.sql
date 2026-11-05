-- Two-stage delivery (ADR 0018). Stage 1 is the consumer: it stores the notifications and flags which ones need an email
-- or a phone push, in the same transaction as the event. Stage 2 is a worker loop that claims flagged rows with a short
-- lease, sends OUTSIDE any transaction, and marks each row right after its send. A rollback of the event can no longer
-- leave a sent message unmarked, and one failing send no longer re-sends the others.
ALTER TABLE notifications.notifications
  ADD COLUMN delivery_marked_at timestamptz NULL,
  ADD COLUMN email_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN push_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN delivery_lease_until timestamptz NULL,
  ADD COLUMN delivery_attempts smallint NOT NULL DEFAULT 0;

-- The delivery loop finds work across businesses, so it needs to see flagged rows without a tenant (ADR 0013): a
-- SELECT-only policy for wb_worker on rows that still need delivery. Everything it writes happens in a per-tenant
-- transaction, where tenant_isolation still applies.
CREATE POLICY delivery_scan ON notifications.notifications FOR SELECT TO wb_worker
  USING (email_pending OR push_pending);
CREATE INDEX notifications_delivery_idx ON notifications.notifications (tenant_id)
  WHERE email_pending OR push_pending;

GRANT UPDATE (delivery_marked_at, email_pending, push_pending, delivery_lease_until, delivery_attempts)
  ON notifications.notifications TO wb_worker;
