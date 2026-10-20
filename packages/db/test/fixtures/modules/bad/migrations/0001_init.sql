CREATE SCHEMA bad AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA bad TO wb_app;
CREATE TABLE bad.leaky (id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL);
CREATE TABLE bad.half (id uuid PRIMARY KEY DEFAULT uuidv7(), tenant_id uuid NOT NULL);
ALTER TABLE bad.half ENABLE ROW LEVEL SECURITY;
