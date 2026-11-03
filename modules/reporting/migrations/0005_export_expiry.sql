-- A finished export is deleted from the store once it expires, and the row keeps the fact that it was.
ALTER TABLE reporting.exports DROP CONSTRAINT exports_status_check;
ALTER TABLE reporting.exports
  ADD CONSTRAINT exports_status_check CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired'));
-- The worker's sweep: ready files past their expiry.
CREATE INDEX exports_expiring_idx ON reporting.exports (expires_at) WHERE status = 'ready';
