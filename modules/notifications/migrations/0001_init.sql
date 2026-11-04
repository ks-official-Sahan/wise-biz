-- notifications: what a person is told in the console (and, later, by email and push). Written by the worker from
-- events and read by the person it is for.
CREATE SCHEMA notifications AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA notifications TO wb_app, wb_worker;

CREATE TABLE notifications.notifications (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  title text NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 120),
  body text NOT NULL CHECK (length(body) <= 500),
  -- An in-app path ("/stock"), never a full URL: the console opens it, nothing leaves the app.
  link text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&.-]{0,200}$'),
  -- The event (or job run) this came from: a redelivered event does not tell the same person twice.
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_pkey PRIMARY KEY (tenant_id, id)
);
-- The bell: a person's newest first, and the unread count (partial: unread rows are few).
CREATE INDEX notifications_user_idx ON notifications.notifications (tenant_id, user_id, id DESC);
CREATE INDEX notifications_unread_idx ON notifications.notifications (tenant_id, user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_idx
  ON notifications.notifications (tenant_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE notifications.preferences (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,40}$'),
  in_app boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT preferences_pkey PRIMARY KEY (tenant_id, user_id, kind)
);

-- Expo push tokens of a person's phones.
CREATE TABLE notifications.push_tokens (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token text NOT NULL CHECK (length(token) BETWEEN 10 AND 200),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_tokens_pkey PRIMARY KEY (tenant_id, user_id, token)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'preferences', 'push_tokens']
  LOOP
    EXECUTE format('ALTER TABLE notifications.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE notifications.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON notifications.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA notifications FROM wb_app, wb_worker;
-- The person reads their own, marks them read, and keeps their own preferences and phones.
GRANT SELECT, UPDATE (read_at) ON notifications.notifications TO wb_app;
GRANT SELECT, INSERT, UPDATE (in_app, email, updated_at) ON notifications.preferences TO wb_app;
GRANT SELECT, INSERT, DELETE ON notifications.push_tokens TO wb_app;
-- The worker writes notifications and reads preferences (to skip what a person turned off) and phones (to push).
GRANT SELECT, INSERT ON notifications.notifications TO wb_worker;
GRANT SELECT ON notifications.preferences, notifications.push_tokens TO wb_worker;
