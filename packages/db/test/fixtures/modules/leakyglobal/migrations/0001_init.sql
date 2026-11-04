-- Negative fixture for findGlobalSchemaLeaks: a "global" schema that wrongly lets wb_app read it.
CREATE SCHEMA leakyglobal AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA leakyglobal TO wb_app;
CREATE TABLE leakyglobal.accounts (id uuid PRIMARY KEY DEFAULT uuidv7(), email text NOT NULL);
GRANT SELECT ON leakyglobal.accounts TO wb_app;
