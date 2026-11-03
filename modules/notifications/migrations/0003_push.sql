-- Phone push delivery. Set once the push was handed to the push service, so a retried event never pushes twice.
ALTER TABLE notifications.notifications ADD COLUMN pushed_at timestamptz NULL;

GRANT UPDATE (pushed_at) ON notifications.notifications TO wb_worker;
-- A token the push service reports as no longer registered is removed (the app was uninstalled or reset).
GRANT DELETE ON notifications.push_tokens TO wb_worker;
