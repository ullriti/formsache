-- Notification templates move from the installation to each organisation
-- (ADR-0032, reversing the "system-wide, tenant-less" design of ADR-0011).
--
-- Three steps, in this order and for a reason: the new column has to exist
-- before it can be filled, and the old one has to keep its content until the
-- backfill below has read it.
--
-- 1. Every organisation gets its own document and its own optimistic counter,
--    mirroring how branding and legal texts are already modelled per tenant
--    (`tenant.branding_revision`, `tenant.legal_revision`).
-- 2. Every *existing* organisation is seeded from the installation's former
--    single row — the same "copied, not inherited" semantics the templates
--    always had (applying a template already copied it into a notification);
--    this only moves the copy earlier, to migration time, and makes each
--    organisation's copy independently editable from here on. Where that row
--    never decided anything (no row, or a NULL column), the shipped floor
--    (`NOTIFICATION_TEMPLATES_FLOOR` in `packages/shared/src/notification-templates.ts`)
--    is used instead — the same floor a fresh organisation is seeded with by
--    `AdminRepository.createTenant`, so every organisation ends up on the same
--    footing whether it already existed or is created after this migration.
-- 3. The old installation-wide column and its counter are dropped: this is a
--    full move, not an added override layer, so there is no reader left for
--    them (ADR-0032).

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "notification_templates" JSONB,
ADD COLUMN     "notification_templates_revision" INTEGER NOT NULL DEFAULT 1;

-- Backfill: copy the installation's former row (if any) into every existing
-- organisation, falling back to the shipped floor where nothing was decided.
-- `LIMIT 1` mirrors the single-row guarantee `system_setting` carried
-- (ADR-0011 §1) — there is at most one row to read here regardless.
UPDATE "tenant"
SET "notification_templates" = COALESCE(
  (SELECT "notification_templates" FROM "system_setting" LIMIT 1),
  '[{"id":"confirmation","name":"Bestätigung an Teilnehmer","description":"Geht an die E-Mail-Adresse aus dem Formular, sobald jemand abgesendet hat.","triggers":["submit"],"format":"html","toSubmitter":true,"subject":"Deine Anmeldung zu {{formular}}","body":"Hallo,\n\nvielen Dank für deine Anmeldung. Wir haben folgende Angaben zu <strong>{{formular}}</strong> von dir erhalten:\n\n{{antworten}}\n\nSolltest du etwas ändern wollen, kannst du deine Anmeldung hier bearbeiten: {{bearbeiten}}\n\nMit freundlichen Grüßen<br />{{formularorganisation}}"},{"id":"office","name":"Meldung ans Büro","description":"Geht an eine feste Adresse, sobald eine neue Antwort eingegangen ist.","triggers":["submit"],"format":"html","toSubmitter":false,"subject":"Neue Antwort: {{formular}}","body":"Zum Formular <strong>{{formular}}</strong> ist am {{datum}} eine neue Antwort eingegangen.\n\n{{antworten}}\n\n{{formularorganisation}}"},{"id":"change","name":"Änderungsmeldung","description":"Geht heraus, wenn eine bereits abgesendete Antwort nachträglich geändert wurde.","triggers":["edit"],"format":"html","toSubmitter":false,"subject":"Änderung: {{formular}}","body":"Eine bereits abgesendete Antwort zum Formular <strong>{{formular}}</strong> wurde nachträglich geändert, am {{datum}}.\n\n<strong>Das hat sich geändert:</strong>\n\n{{aenderungen}}\n\n<strong>Der vollständige Stand:</strong>\n\n{{antworten}}\n\n{{formularorganisation}}"}]'::jsonb
);

-- AlterTable: the old installation-wide row is gone from here — every reader
-- now goes through the organisation's own row instead (ADR-0032).
ALTER TABLE "system_setting" DROP COLUMN "notification_templates",
DROP COLUMN "notification_templates_revision";
