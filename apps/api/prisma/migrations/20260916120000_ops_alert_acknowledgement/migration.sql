-- Acknowledging an operations alert (ADR-0016, continuation 2026-09-16).
--
-- Four columns and one relaxed constraint. The relaxed one is the point worth
-- reading: `last_sent_at` was NOT NULL because a row only ever came into being
-- by sending an alert. An acknowledgement can now create the row first — for a
-- metric that is over its threshold but has not reported yet (no operator
-- address, or simply the same tick). NULL there means "never reported", which
-- is what `due()` already treats a missing row as.
--
-- The four added columns are only meaningful together: `acknowledged_at` set
-- is what makes an acknowledgement exist at all, `acknowledged_until` NULL
-- beside it means "until further notice". They are cleared as a group by the
-- watchman as soon as the metric recovers or the span runs out, so a stale
-- acknowledgement cannot silence a second, unrelated incident.

-- AlterTable
ALTER TABLE "ops_alert" ALTER COLUMN "last_sent_at" DROP NOT NULL;

ALTER TABLE "ops_alert"
  ADD COLUMN "acknowledged_at" TIMESTAMPTZ(3),
  ADD COLUMN "acknowledged_until" TIMESTAMPTZ(3),
  ADD COLUMN "acknowledged_by_id" UUID,
  ADD COLUMN "acknowledged_note" VARCHAR(200);

-- AddForeignKey: the acknowledgement outlives the account that gave it and
-- loses its link to a person in the process — the same trade `ai_usage` makes.
ALTER TABLE "ops_alert"
  ADD CONSTRAINT "ops_alert_acknowledged_by_id_fkey"
  FOREIGN KEY ("acknowledged_by_id") REFERENCES "user"("id")
  ON UPDATE CASCADE ON DELETE SET NULL;
