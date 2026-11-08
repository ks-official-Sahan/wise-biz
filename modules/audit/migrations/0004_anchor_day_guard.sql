-- audit 0004: the chainer may not insert an anchor for a day that has not started (review 2026-11-08).
--
-- audit.anchors is append-only, so a forged future-dated anchor can never be removed and would make the real anchor
-- for that day impossible to write (primary key (tenant_id, day)). Bounding `day` by the current UTC date removes that
-- lever; signing anchors and exporting them to WORM storage stays a separate follow-up (P1-15).
DROP POLICY chainer_insert ON audit.anchors;
CREATE POLICY chainer_insert ON audit.anchors FOR INSERT TO wb_chainer
  WITH CHECK (day <= (now() AT TIME ZONE 'utc')::date);
