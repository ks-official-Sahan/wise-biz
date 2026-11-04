-- Email delivery. The address is copied from the person's verified session when they switch email on, so the worker
-- never reads the identity schema (it is walled off from every role but wb_identity). It refreshes whenever they save
-- their preferences again.
ALTER TABLE notifications.preferences
  ADD COLUMN email_to text NULL CHECK (email_to IS NULL OR (email_to = lower(email_to) AND length(email_to) <= 320)),
  ADD CONSTRAINT preferences_email_has_address CHECK (NOT email OR email_to IS NOT NULL);

-- Set once the email was sent, so a retried event never mails twice.
ALTER TABLE notifications.notifications ADD COLUMN emailed_at timestamptz NULL;

GRANT INSERT, UPDATE (in_app, email, email_to, updated_at) ON notifications.preferences TO wb_app;
GRANT UPDATE (emailed_at) ON notifications.notifications TO wb_worker;
