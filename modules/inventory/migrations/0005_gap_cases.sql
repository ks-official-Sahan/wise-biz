-- Stock-gap cases (P2-04b). A gap case is opened from one variance line of an APPROVED count (the variance is already
-- posted as a count_variance movement). The case is the investigation: assignee, manual tasks, and a resolution code.
--   * One case per count line (unique on the line key): creating cases for a count twice inserts nothing new.
--   * The count window is [opened_at, closed_at] of the count, stored on the case so evidence reads stay stable.
--   * Only misplaced_found moves stock (a found-adjustment at the location where it was found). The other codes are
--     recorded without a stock movement; the variance stays as booked.
--   * Quantities numeric(18,4), values bigint minor units (NULL when the line has no known cost: never 0).

CREATE TABLE inventory.gap_cases (
  id uuid NOT NULL DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  count_id uuid NOT NULL,
  location_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  batch_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Counted minus expected at the count's cut: never 0 (a zero variance is not a gap).
  variance_qty numeric(18,4) NOT NULL CHECK (variance_qty <> 0),
  unit_cost_minor bigint CHECK (unit_cost_minor >= 0),
  value_minor bigint,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'investigating', 'resolved')),
  assignee_id uuid,
  resolution_code text CHECK (resolution_code IN ('theft', 'damage', 'data_error', 'misplaced_found', 'supplier_short')),
  resolution_note text NOT NULL DEFAULT '' CHECK (length(resolution_note) <= 500),
  found_location_id uuid,
  found_qty numeric(18,4) CHECK (found_qty > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gap_cases_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT gap_cases_count_line_fk FOREIGN KEY (tenant_id, count_id, variant_id, batch_id)
    REFERENCES inventory.count_lines (tenant_id, count_id, variant_id, batch_id),
  CONSTRAINT gap_cases_count_line_uq UNIQUE (tenant_id, count_id, variant_id, batch_id),
  CONSTRAINT gap_cases_window CHECK (window_from <= window_to),
  CONSTRAINT gap_cases_resolution CHECK ((status = 'resolved') = (resolution_code IS NOT NULL
    AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)),
  CONSTRAINT gap_cases_found CHECK ((resolution_code = 'misplaced_found')
    = (found_location_id IS NOT NULL AND found_qty IS NOT NULL)),
  -- A found item is a shortage that was booked: only a negative variance can be misplaced-found.
  CONSTRAINT gap_cases_found_short CHECK (resolution_code IS DISTINCT FROM 'misplaced_found' OR variance_qty < 0)
);
-- The case list: by status (open queue) and by assignee (my cases). Partial on assignee: unassigned cases stay out.
CREATE INDEX gap_cases_status_idx ON inventory.gap_cases (tenant_id, status, id);
CREATE INDEX gap_cases_assignee_idx ON inventory.gap_cases (tenant_id, assignee_id, id) WHERE assignee_id IS NOT NULL;

-- Manual investigation steps. Title and creator are immutable; assignee and done state move.
CREATE TABLE inventory.gap_tasks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  case_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  assignee_id uuid,
  done boolean NOT NULL DEFAULT false,
  done_by uuid,
  done_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gap_tasks_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT gap_tasks_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES inventory.gap_cases (tenant_id, id),
  CONSTRAINT gap_tasks_done CHECK (done = (done_at IS NOT NULL AND done_by IS NOT NULL))
);
-- Serves the case's task list and the grouped task counts of a page of cases (one query per page, no N+1).
CREATE INDEX gap_tasks_case_idx ON inventory.gap_tasks (tenant_id, case_id, id);

ALTER TABLE "inventory"."gap_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."gap_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."gap_cases" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "inventory"."gap_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory"."gap_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inventory"."gap_tasks" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege on the NEW tables only. Nothing is deleted. A case moves through the listed columns only; the
-- variance, window, count line and opener are fixed at creation.
REVOKE UPDATE, DELETE, TRUNCATE ON inventory.gap_cases, inventory.gap_tasks FROM wb_app;
GRANT SELECT, INSERT ON inventory.gap_cases, inventory.gap_tasks TO wb_app;
GRANT UPDATE (status, assignee_id, resolution_code, resolution_note, found_location_id, found_qty, resolved_by,
  resolved_at, version, updated_at) ON inventory.gap_cases TO wb_app;
GRANT UPDATE (assignee_id, done, done_by, done_at, updated_at) ON inventory.gap_tasks TO wb_app;
