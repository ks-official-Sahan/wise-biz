-- sales: signed documents from terminals (sales, returns, voids, shifts, drawers, cash movements, overrides) and invoice
-- numbering. Documents are append-only except a sale's status and invoice number, and a shift's closing fields.
--
-- Decisions:
--   * Client-generated UUIDv7 ids are the idempotency keys: re-applying a command finds its row (insert on conflict on
--     the primary key) and answers the same. A different document under a used id is a conflict.
--   * device_documents is the ONE device chain: every signed document takes (terminal, device_seq) once, whatever its
--     type, with its hash, prev_hash and signature. The sync module (P1-06) verifies the chain before dispatching.
--   * sale_lines and return_lines are snapshots (name, unit price, tax, discount, batch cost); reports never re-join
--     current prices. `flags` carries review marks (price_mismatch, stale_price, stale_policy, operator_inactive,
--     operator_unauthorized, expired_batch, batch_reallocated).
--   * invoice_no comes from invoice_sequences with an upsert ... returning, as the LAST write of the sale transaction:
--     a rollback returns the number (gapless), and the per-branch row lock is held as briefly as possible.
--   * Amounts are bigint minor units; quantities numeric(18,4); hashes and signatures bytea.
CREATE SCHEMA sales AUTHORIZATION wb_migrator;
GRANT USAGE ON SCHEMA sales TO wb_app;

CREATE TABLE sales.device_documents (
  tenant_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  device_seq bigint NOT NULL CHECK (device_seq >= 0),
  doc_type text NOT NULL CHECK (doc_type IN ('sale', 'return', 'void', 'shift_open', 'shift_close', 'drawer',
    'cash_movement', 'override')),
  doc_id uuid NOT NULL,
  prev_hash bytea NOT NULL,
  hash bytea NOT NULL,
  signature bytea NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_documents_pkey PRIMARY KEY (tenant_id, terminal_id, device_seq),
  CONSTRAINT device_documents_doc_key UNIQUE (tenant_id, doc_type, doc_id)
);

CREATE TABLE sales.shifts (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  opened_by uuid NOT NULL,
  business_date date NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  opening_float_minor bigint NOT NULL CHECK (opening_float_minor >= 0),
  opened_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by uuid,
  closed_at timestamptz,
  expected_cash_minor bigint,
  counted_cash_minor bigint CHECK (counted_cash_minor >= 0),
  over_short_minor bigint,
  blind_count boolean,
  note text CHECK (btrim(note) <> '' AND length(note) <= 500),
  z_report jsonb,
  flags text[] NOT NULL DEFAULT '{}',
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shifts_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT shifts_closed_fields CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL
    AND counted_cash_minor IS NOT NULL AND expected_cash_minor IS NOT NULL AND over_short_minor IS NOT NULL
    AND blind_count IS NOT NULL AND z_report IS NOT NULL))
);
CREATE INDEX shifts_tenant_branch_idx ON sales.shifts (tenant_id, branch_id, business_date DESC, id DESC);
CREATE INDEX shifts_tenant_terminal_idx ON sales.shifts (tenant_id, terminal_id, opened_at DESC);
-- One open shift per terminal.
CREATE UNIQUE INDEX shifts_one_open_key ON sales.shifts (tenant_id, terminal_id) WHERE status = 'open';

CREATE TABLE sales.invoice_sequences (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  prefix text NOT NULL DEFAULT 'INV' CHECK (prefix ~ '^[A-Z0-9-]{1,12}$'),
  last_no bigint NOT NULL CHECK (last_no >= 1),
  CONSTRAINT invoice_sequences_pkey PRIMARY KEY (tenant_id, branch_id)
);

CREATE TABLE sales.sales (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  customer_id uuid,
  sale_no bigint NOT NULL CHECK (sale_no >= 1),
  invoice_no text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  cash_rounding_minor bigint NOT NULL,
  payable_minor bigint NOT NULL,
  business_date date NOT NULL,
  price_list_id uuid NOT NULL,
  price_list_version int NOT NULL,
  engine_version text NOT NULL,
  policy_version int NOT NULL,
  promotion_ids uuid[] NOT NULL DEFAULT '{}',
  coupons text[] NOT NULL DEFAULT '{}',
  flags text[] NOT NULL DEFAULT '{}',
  -- The stock movements this sale recorded (after any FEFO re-allocation), so a void reverses exactly them.
  stock jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(stock) = 'array'),
  completed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT sales_terminal_no_key UNIQUE (tenant_id, terminal_id, sale_no),
  CONSTRAINT sales_branch_invoice_key UNIQUE (tenant_id, branch_id, invoice_no),
  CONSTRAINT sales_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES sales.shifts (tenant_id, id)
);
CREATE INDEX sales_tenant_branch_date_idx ON sales.sales (tenant_id, branch_id, business_date DESC, id DESC);
CREATE INDEX sales_tenant_shift_idx ON sales.sales (tenant_id, shift_id);
CREATE INDEX sales_tenant_customer_idx ON sales.sales (tenant_id, customer_id, completed_at DESC)
  WHERE customer_id IS NOT NULL;
CREATE INDEX sales_tenant_flagged_idx ON sales.sales (tenant_id, id DESC) WHERE cardinality(flags) > 0;

CREATE TABLE sales.sale_lines (
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  line int NOT NULL CHECK (line >= 0),
  variant_id uuid NOT NULL,
  name text NOT NULL,
  sku text NOT NULL,
  location_id uuid NOT NULL,
  batch_id uuid,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  price_source text NOT NULL CHECK (price_source IN ('override', 'batch', 'list')),
  discount_minor bigint NOT NULL CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  -- The batch's cost when the server knows it (gross margin in reports never re-joins inventory).
  unit_cost_minor bigint CHECK (unit_cost_minor >= 0),
  detail jsonb,
  CONSTRAINT sale_lines_pkey PRIMARY KEY (tenant_id, sale_id, line),
  CONSTRAINT sale_lines_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales.sales (tenant_id, id)
);
CREATE INDEX sale_lines_tenant_variant_idx ON sales.sale_lines (tenant_id, variant_id);

CREATE TABLE sales.sale_tenders (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  kind text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  received_minor bigint CHECK (received_minor >= 0),
  change_minor bigint CHECK (change_minor >= 0),
  foreign_currency char(3),
  foreign_amount_minor bigint,
  fx_rate numeric(20,10),
  card_provider text,
  card_ref text,
  card_auth_code text,
  card_last4 char(4) CHECK (card_last4 ~ '^[0-9]{4}$'),
  card_brand text,
  CONSTRAINT sale_tenders_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT sale_tenders_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales.sales (tenant_id, id)
);
CREATE INDEX sale_tenders_tenant_sale_idx ON sales.sale_tenders (tenant_id, sale_id);

CREATE TABLE sales.overrides (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  requester_id uuid NOT NULL,
  approver_id uuid NOT NULL,
  permission text NOT NULL CHECK (length(permission) <= 100),
  reason text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  before jsonb,
  after jsonb,
  subject_type text,
  subject_id uuid,
  flags text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT overrides_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT overrides_requester_is_not_approver CHECK (requester_id <> approver_id)
);
CREATE INDEX overrides_tenant_subject_idx ON sales.overrides (tenant_id, subject_id) WHERE subject_id IS NOT NULL;

CREATE TABLE sales.voids (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  override_id uuid,
  flags text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voids_pkey PRIMARY KEY (tenant_id, id),
  -- A sale is voided once.
  CONSTRAINT voids_sale_key UNIQUE (tenant_id, sale_id),
  CONSTRAINT voids_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales.sales (tenant_id, id),
  CONSTRAINT voids_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES sales.shifts (tenant_id, id),
  CONSTRAINT voids_override_fk FOREIGN KEY (tenant_id, override_id) REFERENCES sales.overrides (tenant_id, id)
);
CREATE INDEX voids_tenant_shift_idx ON sales.voids (tenant_id, shift_id);
CREATE INDEX voids_tenant_override_idx ON sales.voids (tenant_id, override_id) WHERE override_id IS NOT NULL;

CREATE TABLE sales.returns (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  sale_id uuid,
  return_no bigint NOT NULL CHECK (return_no >= 1),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  business_date date NOT NULL,
  reason text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  override_id uuid,
  flags text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT returns_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT returns_terminal_no_key UNIQUE (tenant_id, terminal_id, return_no),
  CONSTRAINT returns_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES sales.sales (tenant_id, id),
  CONSTRAINT returns_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES sales.shifts (tenant_id, id),
  CONSTRAINT returns_override_fk FOREIGN KEY (tenant_id, override_id) REFERENCES sales.overrides (tenant_id, id),
  CONSTRAINT returns_no_receipt_override CHECK (sale_id IS NOT NULL OR override_id IS NOT NULL)
);
CREATE INDEX returns_tenant_sale_idx ON sales.returns (tenant_id, sale_id) WHERE sale_id IS NOT NULL;
CREATE INDEX returns_tenant_shift_idx ON sales.returns (tenant_id, shift_id);
CREATE INDEX returns_tenant_branch_date_idx ON sales.returns (tenant_id, branch_id, business_date DESC, id DESC);
CREATE INDEX returns_tenant_override_idx ON sales.returns (tenant_id, override_id) WHERE override_id IS NOT NULL;

CREATE TABLE sales.return_lines (
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  line int NOT NULL CHECK (line >= 0),
  sale_id uuid,
  sale_line int,
  variant_id uuid NOT NULL,
  name text NOT NULL,
  sku text NOT NULL,
  location_id uuid NOT NULL,
  batch_id uuid,
  qty numeric(18,4) NOT NULL CHECK (qty > 0),
  refund_minor bigint NOT NULL CHECK (refund_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  disposition text NOT NULL CHECK (disposition IN ('restock', 'writeoff')),
  CONSTRAINT return_lines_pkey PRIMARY KEY (tenant_id, return_id, line),
  CONSTRAINT return_lines_return_fk FOREIGN KEY (tenant_id, return_id) REFERENCES sales.returns (tenant_id, id),
  CONSTRAINT return_lines_sale_line_fk FOREIGN KEY (tenant_id, sale_id, sale_line)
    REFERENCES sales.sale_lines (tenant_id, sale_id, line),
  CONSTRAINT return_lines_sale_pair CHECK ((sale_id IS NULL) = (sale_line IS NULL))
);
-- "How much of this sale line was already returned?"
CREATE INDEX return_lines_tenant_sale_line_idx ON sales.return_lines (tenant_id, sale_id, sale_line)
  WHERE sale_id IS NOT NULL;

CREATE TABLE sales.return_tenders (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  return_id uuid NOT NULL,
  kind text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  CONSTRAINT return_tenders_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT return_tenders_return_fk FOREIGN KEY (tenant_id, return_id) REFERENCES sales.returns (tenant_id, id)
);
CREATE INDEX return_tenders_tenant_return_idx ON sales.return_tenders (tenant_id, return_id);

CREATE TABLE sales.drawer_sessions (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  sale_id uuid,
  reason text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  flags text[] NOT NULL DEFAULT '{}',
  opened_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drawer_sessions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT drawer_sessions_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES sales.shifts (tenant_id, id)
);
CREATE INDEX drawer_sessions_tenant_shift_idx ON sales.drawer_sessions (tenant_id, shift_id);

CREATE TABLE sales.cash_movements (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pay_in', 'pay_out', 'float_add', 'drop')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL CHECK (btrim(reason) <> '' AND length(reason) <= 500),
  flags text[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_movements_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT cash_movements_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES sales.shifts (tenant_id, id)
);
CREATE INDEX cash_movements_tenant_shift_idx ON sales.cash_movements (tenant_id, shift_id);

-- RLS: exact output of rlsSql() from @wise-biz/db.
ALTER TABLE "sales"."device_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."device_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."device_documents" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."shifts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."shifts" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."invoice_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."invoice_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."invoice_sequences" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."sales" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."sales" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."sale_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."sale_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."sale_lines" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."sale_tenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."sale_tenders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."sale_tenders" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."overrides" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."overrides" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."overrides" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."voids" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."voids" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."voids" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."returns" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."return_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."return_lines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."return_lines" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."return_tenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."return_tenders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."return_tenders" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."drawer_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."drawer_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."drawer_sessions" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE "sales"."cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales"."cash_movements" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales"."cash_movements" USING ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Least privilege: documents are insert-only, except what a later document legitimately changes.
REVOKE UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA sales FROM wb_app;
GRANT UPDATE (invoice_no, status) ON sales.sales TO wb_app;
GRANT UPDATE (status, closed_by, closed_at, expected_cash_minor, counted_cash_minor, over_short_minor, blind_count, note,
  z_report, flags) ON sales.shifts TO wb_app;
GRANT UPDATE (last_no) ON sales.invoice_sequences TO wb_app;
