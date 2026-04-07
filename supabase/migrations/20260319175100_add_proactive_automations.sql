CREATE TABLE IF NOT EXISTS "public"."automation_suggestions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "suggested_automation" "jsonb" NOT NULL,
    "suggested_by_user_id" "uuid",
    "decided_by_user_id" "uuid",
    "decided_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE "public"."automation_suggestions" OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."automations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "cadence" "text" NOT NULL,
    "timezone" "text",
    "at_time" time without time zone,
    "day_of_week" smallint,
    "day_of_month" smallint,
    "next_run_at" timestamp with time zone,
    "last_run_at" timestamp with time zone,
    "created_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "automations_cadence_check" CHECK (("cadence" = ANY (ARRAY['daily'::"text", 'weekly'::"text", 'monthly'::"text"]))),
    CONSTRAINT "automations_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'disabled'::"text"]))),
    CONSTRAINT "automations_day_of_week_check" CHECK (("day_of_week" IS NULL) OR (("day_of_week" >= 0) AND ("day_of_week" <= 6))),
    CONSTRAINT "automations_day_of_month_check" CHECK (("day_of_month" IS NULL) OR (("day_of_month" >= 1) AND ("day_of_month" <= 31)))
);

ALTER TABLE "public"."automations" OWNER TO "postgres";

ALTER TABLE ONLY "public"."automation_suggestions"
    ADD CONSTRAINT "automation_suggestions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."automations"
    ADD CONSTRAINT "automations_pkey" PRIMARY KEY ("id");

CREATE INDEX "automation_suggestions_household_id_idx" ON "public"."automation_suggestions" USING "btree" ("household_id");
CREATE INDEX "automation_suggestions_status_idx" ON "public"."automation_suggestions" USING "btree" ("status");
CREATE INDEX "automations_household_id_idx" ON "public"."automations" USING "btree" ("household_id");
CREATE INDEX "automations_next_run_at_idx" ON "public"."automations" USING "btree" ("next_run_at");
CREATE INDEX "automations_status_idx" ON "public"."automations" USING "btree" ("status");

ALTER TABLE ONLY "public"."automation_suggestions"
    ADD CONSTRAINT "automation_suggestions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automation_suggestions"
    ADD CONSTRAINT "automation_suggestions_suggested_by_user_id_fkey" FOREIGN KEY ("suggested_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."automation_suggestions"
    ADD CONSTRAINT "automation_suggestions_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

ALTER TABLE ONLY "public"."automations"
    ADD CONSTRAINT "automations_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "public"."automations"
    ADD CONSTRAINT "automations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;

CREATE OR REPLACE TRIGGER "set_automations_updated_at" BEFORE UPDATE ON "public"."automations" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();

ALTER TABLE "public"."automation_suggestions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."automations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "automation_suggestions_select_household_access" ON "public"."automation_suggestions" FOR SELECT USING ("public"."can_access_household"("household_id"));
CREATE POLICY "automation_suggestions_insert_admin" ON "public"."automation_suggestions" FOR INSERT WITH CHECK ("public"."is_household_admin"("household_id"));
CREATE POLICY "automation_suggestions_update_admin" ON "public"."automation_suggestions" FOR UPDATE USING ("public"."is_household_admin"("household_id")) WITH CHECK ("public"."is_household_admin"("household_id"));
CREATE POLICY "automation_suggestions_delete_admin" ON "public"."automation_suggestions" FOR DELETE USING ("public"."is_household_admin"("household_id"));

CREATE POLICY "automations_select_household_access" ON "public"."automations" FOR SELECT USING ("public"."can_access_household"("household_id"));
CREATE POLICY "automations_insert_admin" ON "public"."automations" FOR INSERT WITH CHECK ("public"."is_household_admin"("household_id"));
CREATE POLICY "automations_update_admin" ON "public"."automations" FOR UPDATE USING ("public"."is_household_admin"("household_id")) WITH CHECK ("public"."is_household_admin"("household_id"));
CREATE POLICY "automations_delete_admin" ON "public"."automations" FOR DELETE USING ("public"."is_household_admin"("household_id"));
