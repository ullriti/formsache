-- Das vollständige Schema in einer Migration.
--
-- **Am 2026-09-13 zusammengefasst: aus zwölf Migrationen wurde diese eine.**
-- Zulässig war das genau einmal und nur unter einer Bedingung — Formsache war
-- zu diesem Zeitpunkt nie veröffentlicht: kein Tag, kein Release, keine
-- Installation im Feld, deren `_prisma_migrations` die elf entfallenen Namen
-- anschließend vermisst hätte. Ab der ersten Veröffentlichung gilt die Regel
-- ausnahmslos: **eine gemergte Migration wird nie wieder angefasst**
-- (`AGENTS.md`, `CONTRIBUTING.md`, `docs/kb/02-data-model.md`).
--
-- Zusammengefasst wurden:
--
--   20260813000000_init                           (selbst schon der Endstand
--                                                  von achtunddreißig)
--   20260814090000_password_reset_tokens          ADR-0020
--   20260814120000_two_layer_form_settings        ADR-0011, ADR-0012
--   20260814140000_system_mail_trigger            ADR-0020
--   20260815120000_form_settings_permission       ADR-0021
--   20260815140000_drop_brand_colors
--   20260817120000_tenant_form_defaults_flat      ADR-0011
--   20260818090000_account_invitations            ADR-0024
--   20260818100000_notification_templates_revision ADR-0022
--   20260819090000_legal_pages                    ADR-0027
--   20260819120000_form_privacy_notice            ADR-0028
--   20260824090000_drop_accessibility_legal_page
--
-- Die Begründungen dieser Schritte standen in den Kopfzeilen der entfallenen
-- Dateien. Sie sind nicht verloren, sondern dort, wo sie ohnehin hingehören:
-- in den genannten ADRs und in `docs/kb/02-data-model.md`.
--
-- Erzeugt wurde diese Datei **nicht** mit `prisma migrate diff --from-empty
-- --to-schema`, sondern indem die zwölf auf eine leere Datenbank angewandt und
-- der Endstand mit `pg_dump --schema-only` abgezogen wurde. Der Unterschied ist
-- nicht kosmetisch, er wurde gemessen: Prismas Datenmodell kennt weder Trigger
-- noch CHECK-Bedingungen, und die aus ihm erzeugte Migration hätte still
-- verloren
--
--   * die Funktion `file_columns_are_immutable` samt Trigger
--     `file_immutable_columns`, die `kind`, `tenant_id` und `form_id` einer
--     Datei nach dem Anlegen festhält (ADR-0014 Nr. 3);
--   * acht CHECK-Bedingungen — `ai_usage_prompt_erasure_shape`,
--     `ai_usage_tokens_nonnegative`, `event_registration_seats_positive`,
--     `file_kind_shape`, `system_setting_single_row`,
--     `tenant_ai_monthly_call_limit_nonnegative`, `user_local_or_oidc` und
--     `user_oidc_identity_complete`.
--
-- Zusammen sind das zehn Zusagen, die die Datenbank selbst durchsetzt und die
-- kein Anwendungscode nachholt. Auch `prisma migrate diff` zwischen zwei
-- Datenbanken hätte den Verlust nicht gemeldet — es vergleicht nur, was Prisma
-- modelliert. Der Nachweis lief deshalb über `pg_dump` beider Stände.
--
-- Neu erzeugen (falls vor der ersten Veröffentlichung je nötig): die
-- Migrationen auf eine leere Datenbank anwenden, dann
--
--   pg_dump --schema-only --no-owner --no-acl --no-comments \
--           --schema=public --exclude-table=_prisma_migrations
--
-- und aus dem Ergebnis die psql-Metabefehle (`\restrict`), die `SET`-Zeilen der
-- Sitzung und `CREATE SCHEMA public;` streichen — Prisma spielt die Datei nicht
-- über psql ein, und das Schema `public` bringt jede frische Datenbank mit.
--
-- **Die Reihenfolge der `ALTER TABLE … ADD CONSTRAINT`-Blöcke unten ist nicht
-- gleichgültig, und sie bleibt trotzdem so, wie `pg_dump` sie ausgibt.**
-- PostgreSQL führt die Fremdschlüssel-Aktionen eines `DELETE` in der
-- Reihenfolge der Trigger-Namen aus, und die heißen
-- `RI_ConstraintTrigger_a_<oid>` — sie tragen also die Reihenfolge, in der die
-- Bedingungen angelegt wurden. Diese Datei legt sie alphabetisch an, die
-- entfallene Kette legte sie in Migrationsreihenfolge an; die Kataloge sind
-- zeichengleich, die Kaskaden laufen in anderer Folge. Gemessen wurde das am
-- 2026-09-13 an `DELETE FROM form`, wo `mail_log` als einzige Tabelle zwei
-- sterbende Eltern hat (`form` und die mitkaskadierte `notification`): in der
-- alten Folge ging es gut, in dieser scheiterte es. Der Fehler lag nicht in
-- der Reihenfolge, sondern in `ScopedFormDelegate.purgeForm`, das sich auf sie
-- verlassen hatte; die Route löst ihre Verweise seither selbst. Die Folge hier
-- zu „reparieren" hieße, den Fehler wieder zuzudecken — und den Regressionstest
-- `apps/api/test/trash/permanent-delete.spec.ts` grün zu stellen, ohne dass er
-- noch etwas belegt.

-- PostgreSQL database dump
--

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

-- Name: ai_outcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_outcome AS ENUM (
    'ok',
    'timeout',
    'rate_limited',
    'invalid_output',
    'truncated',
    'refused',
    'unavailable'
);

-- Name: ai_provider; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ai_provider AS ENUM (
    'anthropic',
    'mistral'
);

-- Name: file_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.file_kind AS ENUM (
    'response_attachment',
    'tenant_logo'
);

-- Name: file_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.file_status AS ENUM (
    'pending',
    'stored'
);

-- Name: form_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.form_status AS ENUM (
    'draft',
    'active'
);

-- Name: form_template_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.form_template_kind AS ENUM (
    'form',
    'page',
    'question'
);

-- Name: job_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_kind AS ENUM (
    'mail_worker',
    'mail_log_purge',
    'file_purge',
    'retention_purge',
    'ai_prompt_purge',
    'ops_alert',
    'session_purge'
);

-- Name: job_outcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.job_outcome AS ENUM (
    'ok',
    'failed'
);

-- Name: mail_format; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mail_format AS ENUM (
    'html',
    'text'
);

-- Name: mail_sender_identity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mail_sender_identity AS ENUM (
    'system',
    'own'
);

-- Name: mail_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.mail_status AS ENUM (
    'queued',
    'sent',
    'failed'
);

-- Name: notification_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_trigger AS ENUM (
    'submit',
    'save',
    'edit',
    'system'
);

-- Name: ops_metric; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ops_metric AS ENUM (
    'mail_queue_age',
    'mail_failures',
    'job_stale',
    'storage_full',
    'ai_failure_rate'
);

-- Name: password_reset_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.password_reset_kind AS ENUM (
    'reset',
    'invitation'
);

-- Name: file_columns_are_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.file_columns_are_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW."kind" IS DISTINCT FROM OLD."kind"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."form_id" IS DISTINCT FROM OLD."form_id" THEN
        RAISE EXCEPTION
            'file.kind, file.tenant_id and file.form_id are immutable (ADR-0014 Nr. 3)'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    provider public.ai_provider NOT NULL,
    model text NOT NULL,
    outcome public.ai_outcome,
    input_tokens integer,
    output_tokens integer,
    prompt text,
    prompt_erased_at timestamp(3) with time zone,
    model_resolved text,
    CONSTRAINT ai_usage_prompt_erasure_shape CHECK (((prompt_erased_at IS NULL) OR (prompt IS NULL))),
    CONSTRAINT ai_usage_tokens_nonnegative CHECK ((((input_tokens IS NULL) OR (input_tokens >= 0)) AND ((output_tokens IS NULL) OR (output_tokens >= 0))))
);

-- Name: event_registration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_registration (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    response_id uuid NOT NULL,
    question_id uuid NOT NULL,
    event_key text NOT NULL,
    seats integer NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT event_registration_seats_positive CHECK ((seats >= 1))
);

-- Name: file; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.file (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind public.file_kind NOT NULL,
    form_id uuid,
    response_id uuid,
    public_ref text NOT NULL,
    file_name text NOT NULL,
    content_type text NOT NULL,
    byte_size integer,
    status public.file_status DEFAULT 'pending'::public.file_status NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    draft_id uuid,
    CONSTRAINT file_kind_shape CHECK ((((kind = 'response_attachment'::public.file_kind) AND (form_id IS NOT NULL) AND (NOT ((response_id IS NOT NULL) AND (draft_id IS NOT NULL)))) OR ((kind = 'tenant_logo'::public.file_kind) AND (form_id IS NULL) AND (response_id IS NULL) AND (draft_id IS NULL))))
);

-- Name: form; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    status public.form_status DEFAULT 'draft'::public.form_status NOT NULL,
    draft_schema jsonb NOT NULL,
    published_version_id uuid,
    public_slug text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    deleted_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    settings_override jsonb DEFAULT '{}'::jsonb NOT NULL,
    settings_revision integer DEFAULT 1 NOT NULL,
    privacy_notice jsonb
);

-- Name: form_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_permission (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    user_id uuid NOT NULL,
    access_revoked boolean DEFAULT false NOT NULL,
    capped_group_id uuid,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

-- Name: form_template; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_template (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    kind public.form_template_kind NOT NULL,
    name text NOT NULL,
    content jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

-- Name: form_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.form_version (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    version integer NOT NULL,
    schema jsonb NOT NULL,
    published_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Name: group; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."group" (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    color text NOT NULL,
    rank integer NOT NULL,
    can_build boolean DEFAULT false NOT NULL,
    can_view_responses boolean DEFAULT false NOT NULL,
    can_export boolean DEFAULT false NOT NULL,
    can_manage_settings boolean DEFAULT false NOT NULL,
    can_manage_users boolean DEFAULT false NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    can_manage_form_settings boolean DEFAULT false NOT NULL
);

-- Name: job_run; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_run (
    id uuid NOT NULL,
    job public.job_kind NOT NULL,
    started_at timestamp(3) with time zone NOT NULL,
    finished_at timestamp(3) with time zone NOT NULL,
    outcome public.job_outcome NOT NULL,
    item_count integer DEFAULT 0 NOT NULL,
    error_class text,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Name: mail_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mail_log (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid,
    notification_id uuid,
    recipient text,
    subject text,
    status public.mail_status DEFAULT 'queued'::public.mail_status NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    next_attempt_at timestamp(3) with time zone,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sent_at timestamp(3) with time zone,
    response_id uuid,
    body_html text,
    body_text text,
    trigger public.notification_trigger DEFAULT 'submit'::public.notification_trigger NOT NULL,
    sender_address text,
    sender_identity public.mail_sender_identity,
    reply_to text,
    failed_at timestamp(3) with time zone
);

-- Name: membership; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    group_id uuid NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL
);

-- Name: notification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    name text NOT NULL,
    format public.mail_format DEFAULT 'html'::public.mail_format NOT NULL,
    to_submitter boolean DEFAULT false NOT NULL,
    recipients jsonb DEFAULT '[]'::jsonb NOT NULL,
    subject text NOT NULL,
    body text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    triggers public.notification_trigger[] DEFAULT ARRAY['submit'::public.notification_trigger] NOT NULL,
    reply_to text
);

-- Name: ops_alert; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops_alert (
    metric public.ops_metric NOT NULL,
    last_sent_at timestamp(3) with time zone NOT NULL
);

-- Name: password_reset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    mail_log_id uuid,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    used_at timestamp(3) with time zone,
    kind public.password_reset_kind DEFAULT 'reset'::public.password_reset_kind NOT NULL
);

-- Name: response; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.response (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    form_version_id uuid NOT NULL,
    answers jsonb NOT NULL,
    submitted_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    deleted_at timestamp(3) with time zone,
    edit_token text,
    edited_at timestamp(3) with time zone
);

-- Name: response_draft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.response_draft (
    id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    form_id uuid NOT NULL,
    form_version_id uuid NOT NULL,
    token text NOT NULL,
    answers jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL
);

-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id uuid NOT NULL,
    token_hash bytea NOT NULL,
    user_id uuid NOT NULL,
    active_tenant_id uuid,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_seen_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp(3) with time zone NOT NULL,
    revoked_at timestamp(3) with time zone
);

-- Name: system_setting; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_setting (
    id character(1) DEFAULT 'x'::bpchar NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    notification_templates jsonb,
    public_base_url text,
    smtp jsonb,
    mail_revision integer DEFAULT 1 NOT NULL,
    reply_to text,
    ops_alert_email text,
    ai_enabled boolean DEFAULT true NOT NULL,
    ai_provider text,
    ai_model text,
    ai_region text,
    ai_api_key text,
    ai_revision integer DEFAULT 1 NOT NULL,
    notification_templates_revision integer DEFAULT 1 NOT NULL,
    legal_pages jsonb,
    legal_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT system_setting_single_row CHECK ((id = 'x'::bpchar))
);

-- Name: tenant; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant (
    id uuid NOT NULL,
    short_name text NOT NULL,
    name text NOT NULL,
    logo_ref text,
    logo_wide boolean DEFAULT false NOT NULL,
    stripe_colors text[],
    accent_color text NOT NULL,
    header_color text NOT NULL,
    canvas_color text NOT NULL,
    oidc_enabled boolean DEFAULT false NOT NULL,
    oidc_issuer text,
    oidc_client_id text,
    oidc_client_secret_encrypted bytea,
    oidc_scopes text[],
    oidc_button_label text,
    form_defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    form_defaults_revision integer DEFAULT 1 NOT NULL,
    branding_revision integer DEFAULT 1 NOT NULL,
    public_base_url text,
    smtp jsonb,
    deleted_at timestamp(3) with time zone,
    reply_to text,
    oidc_email_claim text DEFAULT 'email'::text NOT NULL,
    oidc_email_verified_claim text DEFAULT 'email_verified'::text NOT NULL,
    ai_monthly_call_limit integer DEFAULT 50 NOT NULL,
    ai_enabled boolean,
    legal_pages jsonb,
    legal_revision integer DEFAULT 1 NOT NULL,
    CONSTRAINT tenant_ai_monthly_call_limit_nonnegative CHECK ((ai_monthly_call_limit >= 0))
);

-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id uuid NOT NULL,
    email text NOT NULL,
    name text NOT NULL,
    password_hash text,
    oidc_subject text,
    oidc_issuer text,
    is_superadmin boolean DEFAULT false NOT NULL,
    created_at timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) with time zone NOT NULL,
    CONSTRAINT user_local_or_oidc CHECK (((password_hash IS NULL) OR (oidc_issuer IS NULL))),
    CONSTRAINT user_oidc_identity_complete CHECK (((oidc_subject IS NULL) OR (oidc_issuer IS NOT NULL)))
);

-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);

-- Name: event_registration event_registration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_registration
    ADD CONSTRAINT event_registration_pkey PRIMARY KEY (id);

-- Name: file file_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file
    ADD CONSTRAINT file_pkey PRIMARY KEY (id);

-- Name: form_permission form_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_permission
    ADD CONSTRAINT form_permission_pkey PRIMARY KEY (id);

-- Name: form form_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form
    ADD CONSTRAINT form_pkey PRIMARY KEY (id);

-- Name: form_template form_template_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_template
    ADD CONSTRAINT form_template_pkey PRIMARY KEY (id);

-- Name: form_version form_version_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_pkey PRIMARY KEY (id);

-- Name: group group_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."group"
    ADD CONSTRAINT group_pkey PRIMARY KEY (id);

-- Name: job_run job_run_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_run
    ADD CONSTRAINT job_run_pkey PRIMARY KEY (id);

-- Name: mail_log mail_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_log
    ADD CONSTRAINT mail_log_pkey PRIMARY KEY (id);

-- Name: membership membership_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_pkey PRIMARY KEY (id);

-- Name: notification notification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_pkey PRIMARY KEY (id);

-- Name: ops_alert ops_alert_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops_alert
    ADD CONSTRAINT ops_alert_pkey PRIMARY KEY (metric);

-- Name: password_reset password_reset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset
    ADD CONSTRAINT password_reset_pkey PRIMARY KEY (id);

-- Name: response_draft response_draft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_draft
    ADD CONSTRAINT response_draft_pkey PRIMARY KEY (id);

-- Name: response response_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_pkey PRIMARY KEY (id);

-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);

-- Name: system_setting system_setting_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_setting
    ADD CONSTRAINT system_setting_pkey PRIMARY KEY (id);

-- Name: tenant tenant_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant
    ADD CONSTRAINT tenant_pkey PRIMARY KEY (id);

-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);

-- Name: ai_usage_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_created_at_idx ON public.ai_usage USING btree (created_at);

-- Name: ai_usage_tenant_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_usage_tenant_id_created_at_idx ON public.ai_usage USING btree (tenant_id, created_at);

-- Name: event_registration_form_id_question_id_event_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_registration_form_id_question_id_event_key_idx ON public.event_registration USING btree (form_id, question_id, event_key);

-- Name: event_registration_response_id_question_id_event_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_registration_response_id_question_id_event_key_key ON public.event_registration USING btree (response_id, question_id, event_key);

-- Name: event_registration_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_registration_tenant_id_idx ON public.event_registration USING btree (tenant_id);

-- Name: file_draft_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_draft_id_idx ON public.file USING btree (draft_id);

-- Name: file_form_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_form_id_idx ON public.file USING btree (form_id);

-- Name: file_public_ref_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX file_public_ref_key ON public.file USING btree (public_ref);

-- Name: file_response_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_response_id_created_at_idx ON public.file USING btree (response_id, created_at);

-- Name: file_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX file_tenant_id_idx ON public.file USING btree (tenant_id);

-- Name: form_id_tenant_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_id_tenant_id_key ON public.form USING btree (id, tenant_id);

-- Name: form_permission_capped_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_permission_capped_group_id_idx ON public.form_permission USING btree (capped_group_id);

-- Name: form_permission_form_id_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_permission_form_id_user_id_key ON public.form_permission USING btree (form_id, user_id);

-- Name: form_permission_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_permission_tenant_id_idx ON public.form_permission USING btree (tenant_id);

-- Name: form_permission_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_permission_user_id_idx ON public.form_permission USING btree (user_id);

-- Name: form_public_slug_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_public_slug_key ON public.form USING btree (public_slug);

-- Name: form_published_version_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_published_version_id_key ON public.form USING btree (published_version_id);

-- Name: form_template_id_tenant_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_template_id_tenant_id_key ON public.form_template USING btree (id, tenant_id);

-- Name: form_template_tenant_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_template_tenant_id_created_at_idx ON public.form_template USING btree (tenant_id, created_at);

-- Name: form_tenant_id_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_tenant_id_deleted_at_idx ON public.form USING btree (tenant_id, deleted_at);

-- Name: form_version_form_id_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_version_form_id_version_key ON public.form_version USING btree (form_id, version);

-- Name: form_version_id_tenant_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX form_version_id_tenant_id_key ON public.form_version USING btree (id, tenant_id);

-- Name: form_version_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX form_version_tenant_id_idx ON public.form_version USING btree (tenant_id);

-- Name: group_id_tenant_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_id_tenant_id_key ON public."group" USING btree (id, tenant_id);

-- Name: group_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX group_tenant_id_idx ON public."group" USING btree (tenant_id);

-- Name: group_tenant_id_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX group_tenant_id_name_key ON public."group" USING btree (tenant_id, name);

-- Name: job_run_job_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX job_run_job_started_at_idx ON public.job_run USING btree (job, started_at DESC);

-- Name: mail_log_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_log_created_at_idx ON public.mail_log USING btree (created_at);

-- Name: mail_log_form_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_log_form_id_created_at_idx ON public.mail_log USING btree (form_id, created_at);

-- Name: mail_log_response_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_log_response_id_idx ON public.mail_log USING btree (response_id);

-- Name: mail_log_status_failed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_log_status_failed_at_idx ON public.mail_log USING btree (status, failed_at);

-- Name: mail_log_status_next_attempt_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_log_status_next_attempt_at_idx ON public.mail_log USING btree (status, next_attempt_at);

-- Name: mail_log_tenant_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mail_log_tenant_id_created_at_idx ON public.mail_log USING btree (tenant_id, created_at);

-- Name: membership_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_group_id_idx ON public.membership USING btree (group_id);

-- Name: membership_tenant_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_tenant_id_idx ON public.membership USING btree (tenant_id);

-- Name: membership_tenant_id_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX membership_tenant_id_user_id_key ON public.membership USING btree (tenant_id, user_id);

-- Name: membership_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_user_id_idx ON public.membership USING btree (user_id);

-- Name: notification_tenant_id_form_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_tenant_id_form_id_idx ON public.notification USING btree (tenant_id, form_id);

-- Name: password_reset_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_expires_at_idx ON public.password_reset USING btree (expires_at);

-- Name: password_reset_mail_log_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX password_reset_mail_log_id_key ON public.password_reset USING btree (mail_log_id);

-- Name: password_reset_token_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX password_reset_token_hash_key ON public.password_reset USING btree (token_hash);

-- Name: password_reset_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_reset_user_id_idx ON public.password_reset USING btree (user_id);

-- Name: response_draft_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX response_draft_expires_at_idx ON public.response_draft USING btree (expires_at);

-- Name: response_draft_tenant_id_form_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX response_draft_tenant_id_form_id_idx ON public.response_draft USING btree (tenant_id, form_id);

-- Name: response_draft_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX response_draft_token_key ON public.response_draft USING btree (token);

-- Name: response_edit_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX response_edit_token_key ON public.response USING btree (edit_token);

-- Name: response_form_version_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX response_form_version_id_idx ON public.response USING btree (form_version_id);

-- Name: response_id_tenant_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX response_id_tenant_id_key ON public.response USING btree (id, tenant_id);

-- Name: response_tenant_id_form_id_deleted_at_submitted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX response_tenant_id_form_id_deleted_at_submitted_at_idx ON public.response USING btree (tenant_id, form_id, deleted_at, submitted_at);

-- Name: session_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_expires_at_idx ON public.session USING btree (expires_at);

-- Name: session_revoked_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_revoked_at_idx ON public.session USING btree (revoked_at);

-- Name: session_token_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_token_hash_key ON public.session USING btree (token_hash);

-- Name: session_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_user_id_idx ON public.session USING btree (user_id);

-- Name: tenant_deleted_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tenant_deleted_at_idx ON public.tenant USING btree (deleted_at);

-- Name: tenant_short_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX tenant_short_name_key ON public.tenant USING btree (short_name);

-- Name: user_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_email_key ON public."user" USING btree (email);

-- Name: user_oidc_issuer_oidc_subject_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_oidc_issuer_oidc_subject_key ON public."user" USING btree (oidc_issuer, oidc_subject);

-- Name: file file_immutable_columns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER file_immutable_columns BEFORE UPDATE ON public.file FOR EACH ROW EXECUTE FUNCTION public.file_columns_are_immutable();

-- Name: ai_usage ai_usage_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: ai_usage ai_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Name: event_registration event_registration_form_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_registration
    ADD CONSTRAINT event_registration_form_id_tenant_id_fkey FOREIGN KEY (form_id, tenant_id) REFERENCES public.form(id, tenant_id) ON DELETE CASCADE;

-- Name: event_registration event_registration_response_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_registration
    ADD CONSTRAINT event_registration_response_id_tenant_id_fkey FOREIGN KEY (response_id, tenant_id) REFERENCES public.response(id, tenant_id) ON DELETE CASCADE;

-- Name: event_registration event_registration_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_registration
    ADD CONSTRAINT event_registration_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: file file_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file
    ADD CONSTRAINT file_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.response_draft(id) ON DELETE SET NULL;

-- Name: file file_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file
    ADD CONSTRAINT file_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.form(id);

-- Name: file file_response_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file
    ADD CONSTRAINT file_response_id_fkey FOREIGN KEY (response_id) REFERENCES public.response(id) ON DELETE SET NULL;

-- Name: file file_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.file
    ADD CONSTRAINT file_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: form_permission form_permission_capped_group_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_permission
    ADD CONSTRAINT form_permission_capped_group_id_tenant_id_fkey FOREIGN KEY (capped_group_id, tenant_id) REFERENCES public."group"(id, tenant_id);

-- Name: form_permission form_permission_form_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_permission
    ADD CONSTRAINT form_permission_form_id_tenant_id_fkey FOREIGN KEY (form_id, tenant_id) REFERENCES public.form(id, tenant_id) ON DELETE CASCADE;

-- Name: form_permission form_permission_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_permission
    ADD CONSTRAINT form_permission_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: form_permission form_permission_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_permission
    ADD CONSTRAINT form_permission_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: form form_published_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form
    ADD CONSTRAINT form_published_version_id_fkey FOREIGN KEY (published_version_id) REFERENCES public.form_version(id);

-- Name: form_template form_template_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_template
    ADD CONSTRAINT form_template_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: form form_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form
    ADD CONSTRAINT form_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: form_version form_version_form_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_form_id_tenant_id_fkey FOREIGN KEY (form_id, tenant_id) REFERENCES public.form(id, tenant_id) ON DELETE CASCADE;

-- Name: form_version form_version_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.form_version
    ADD CONSTRAINT form_version_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: group group_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."group"
    ADD CONSTRAINT group_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: mail_log mail_log_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_log
    ADD CONSTRAINT mail_log_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.form(id) ON DELETE SET NULL;

-- Name: mail_log mail_log_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_log
    ADD CONSTRAINT mail_log_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.notification(id) ON DELETE SET NULL;

-- Name: mail_log mail_log_response_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_log
    ADD CONSTRAINT mail_log_response_id_fkey FOREIGN KEY (response_id) REFERENCES public.response(id) ON DELETE SET NULL;

-- Name: mail_log mail_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mail_log
    ADD CONSTRAINT mail_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: membership membership_group_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_group_id_tenant_id_fkey FOREIGN KEY (group_id, tenant_id) REFERENCES public."group"(id, tenant_id);

-- Name: membership membership_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: membership membership_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership
    ADD CONSTRAINT membership_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: notification notification_form_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_form_id_tenant_id_fkey FOREIGN KEY (form_id, tenant_id) REFERENCES public.form(id, tenant_id) ON DELETE CASCADE;

-- Name: notification notification_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification
    ADD CONSTRAINT notification_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: password_reset password_reset_mail_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset
    ADD CONSTRAINT password_reset_mail_log_id_fkey FOREIGN KEY (mail_log_id) REFERENCES public.mail_log(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Name: password_reset password_reset_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset
    ADD CONSTRAINT password_reset_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: response_draft response_draft_form_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_draft
    ADD CONSTRAINT response_draft_form_id_tenant_id_fkey FOREIGN KEY (form_id, tenant_id) REFERENCES public.form(id, tenant_id) ON DELETE CASCADE;

-- Name: response_draft response_draft_form_version_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_draft
    ADD CONSTRAINT response_draft_form_version_id_tenant_id_fkey FOREIGN KEY (form_version_id, tenant_id) REFERENCES public.form_version(id, tenant_id) ON DELETE CASCADE;

-- Name: response_draft response_draft_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response_draft
    ADD CONSTRAINT response_draft_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: response response_form_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_form_id_tenant_id_fkey FOREIGN KEY (form_id, tenant_id) REFERENCES public.form(id, tenant_id) ON DELETE CASCADE;

-- Name: response response_form_version_id_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_form_version_id_tenant_id_fkey FOREIGN KEY (form_version_id, tenant_id) REFERENCES public.form_version(id, tenant_id) ON DELETE RESTRICT;

-- Name: response response_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.response
    ADD CONSTRAINT response_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- Name: session session_active_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_active_tenant_id_fkey FOREIGN KEY (active_tenant_id) REFERENCES public.tenant(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Name: session session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- PostgreSQL database dump complete
--
