


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."can_access_household"("_household_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select public.is_support_user() or public.is_household_member(_household_id);
$$;


ALTER FUNCTION "public"."can_access_household"("_household_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_household_admin"("_household_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = _household_id
      and hm.user_id = auth.uid()
      and hm.role in ('admin', 'owner')
  );
$$;


ALTER FUNCTION "public"."is_household_admin"("_household_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_household_member"("_household_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = _household_id and hm.user_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_household_member"("_household_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_support_user"() RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (select 1 from public.support_users su where su.user_id = auth.uid());
$$;


ALTER FUNCTION "public"."is_support_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_timestamp"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."agent_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "household_id" "uuid",
    "table_name" "text" NOT NULL,
    "row_ref" "jsonb",
    "action" "text" NOT NULL,
    "reason" "text",
    "patch" "jsonb",
    "before" "jsonb",
    "after" "jsonb",
    CONSTRAINT "agent_audit_log_action_check" CHECK (("action" = ANY (ARRAY['create'::"text", 'patch'::"text", 'delete'::"text"])))
);


ALTER TABLE "public"."agent_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text",
    "severity" smallint DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "priority" smallint DEFAULT 1 NOT NULL,
    "due_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "household_id" "uuid" NOT NULL
);


ALTER TABLE "public"."chores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."helpers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "household_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "text",
    "phone" "text",
    "notes" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."helpers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."household_members" (
    "household_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "household_members_role_check" CHECK (("role" = ANY (ARRAY['member'::"text", 'admin'::"text", 'owner'::"text"])))
);


ALTER TABLE "public"."household_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."households" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."households" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."kv_store_e874fae9" (
    "key" "text" NOT NULL,
    "value" "jsonb" NOT NULL
);


ALTER TABLE "public"."kv_store_e874fae9" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text",
    "avatar_url" "text",
    "last_active_household_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "support_user_id" "uuid" NOT NULL,
    "household_id" "uuid",
    "table_name" "text" NOT NULL,
    "row_ref" "jsonb",
    "action" "text" NOT NULL,
    "patch" "jsonb",
    "before" "jsonb",
    "after" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_users" (
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_users" OWNER TO "postgres";


ALTER TABLE ONLY "public"."agent_audit_log"
    ADD CONSTRAINT "agent_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."alerts"
    ADD CONSTRAINT "alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chores"
    ADD CONSTRAINT "chores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."helpers"
    ADD CONSTRAINT "helpers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_pkey" PRIMARY KEY ("household_id", "user_id");



ALTER TABLE ONLY "public"."households"
    ADD CONSTRAINT "households_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."kv_store_e874fae9"
    ADD CONSTRAINT "kv_store_e874fae9_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_audit_log"
    ADD CONSTRAINT "support_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_users"
    ADD CONSTRAINT "support_users_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "alerts_household_id_idx" ON "public"."alerts" USING "btree" ("household_id");



CREATE INDEX "alerts_scheduled_at_idx" ON "public"."alerts" USING "btree" ("scheduled_at");



CREATE INDEX "chores_due_at_idx" ON "public"."chores" USING "btree" ("due_at");



CREATE INDEX "chores_household_id_idx" ON "public"."chores" USING "btree" ("household_id");



CREATE INDEX "chores_user_id_idx" ON "public"."chores" USING "btree" ("user_id");



CREATE INDEX "helpers_household_id_idx" ON "public"."helpers" USING "btree" ("household_id");



CREATE INDEX "household_members_user_id_idx" ON "public"."household_members" USING "btree" ("user_id");



CREATE INDEX "idx_chores_due_at" ON "public"."chores" USING "btree" ("due_at");



CREATE INDEX "idx_chores_status" ON "public"."chores" USING "btree" ("status");



CREATE INDEX "idx_chores_user_id" ON "public"."chores" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_chores_updated_at" BEFORE UPDATE ON "public"."chores" FOR EACH ROW EXECUTE FUNCTION "public"."handle_updated_at"();



CREATE OR REPLACE TRIGGER "set_timestamp_on_chores" BEFORE UPDATE ON "public"."chores" FOR EACH ROW EXECUTE FUNCTION "public"."trigger_set_timestamp"();



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."helpers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."agent_audit_log"
    ADD CONSTRAINT "agent_audit_log_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."users"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."agent_audit_log"
    ADD CONSTRAINT "agent_audit_log_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."alerts"
    ADD CONSTRAINT "alerts_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chores"
    ADD CONSTRAINT "chores_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."helpers"
    ADD CONSTRAINT "helpers_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."households"
    ADD CONSTRAINT "households_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_last_active_household_fk" FOREIGN KEY ("last_active_household_id") REFERENCES "public"."households"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_audit_log"
    ADD CONSTRAINT "support_audit_log_support_user_id_fkey" FOREIGN KEY ("support_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."support_users"
    ADD CONSTRAINT "support_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."agent_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "agent_audit_select_own" ON "public"."agent_audit_log" FOR SELECT TO "authenticated" USING (("actor_user_id" = "auth"."uid"()));



ALTER TABLE "public"."alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "alerts_delete_admin" ON "public"."alerts" FOR DELETE USING ("public"."is_household_admin"("household_id"));



CREATE POLICY "alerts_insert_admin" ON "public"."alerts" FOR INSERT WITH CHECK ("public"."is_household_admin"("household_id"));



CREATE POLICY "alerts_select_household_access" ON "public"."alerts" FOR SELECT USING ("public"."can_access_household"("household_id"));



CREATE POLICY "alerts_update_admin" ON "public"."alerts" FOR UPDATE USING ("public"."is_household_admin"("household_id")) WITH CHECK ("public"."is_household_admin"("household_id"));



ALTER TABLE "public"."chores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chores_delete_admin" ON "public"."chores" FOR DELETE USING ("public"."is_household_admin"("household_id"));



CREATE POLICY "chores_insert_admin" ON "public"."chores" FOR INSERT WITH CHECK ("public"."is_household_admin"("household_id"));



CREATE POLICY "chores_select_household_access" ON "public"."chores" FOR SELECT USING ("public"."can_access_household"("household_id"));



CREATE POLICY "chores_update_admin" ON "public"."chores" FOR UPDATE USING ("public"."is_household_admin"("household_id")) WITH CHECK ("public"."is_household_admin"("household_id"));



ALTER TABLE "public"."helpers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "helpers_delete_admin" ON "public"."helpers" FOR DELETE USING ("public"."is_household_admin"("household_id"));



CREATE POLICY "helpers_insert_admin" ON "public"."helpers" FOR INSERT WITH CHECK ("public"."is_household_admin"("household_id"));



CREATE POLICY "helpers_select_household_access" ON "public"."helpers" FOR SELECT USING ("public"."can_access_household"("household_id"));



CREATE POLICY "helpers_update_admin" ON "public"."helpers" FOR UPDATE USING ("public"."is_household_admin"("household_id")) WITH CHECK ("public"."is_household_admin"("household_id"));



ALTER TABLE "public"."household_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "household_members_delete_admin" ON "public"."household_members" FOR DELETE USING ("public"."is_household_admin"("household_id"));



CREATE POLICY "household_members_insert_admin" ON "public"."household_members" FOR INSERT WITH CHECK ("public"."is_household_admin"("household_id"));



CREATE POLICY "household_members_select_member_or_support" ON "public"."household_members" FOR SELECT USING (("public"."is_support_user"() OR "public"."is_household_member"("household_id")));



CREATE POLICY "household_members_update_admin" ON "public"."household_members" FOR UPDATE USING ("public"."is_household_admin"("household_id")) WITH CHECK ("public"."is_household_admin"("household_id"));



ALTER TABLE "public"."households" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "households_delete_admin" ON "public"."households" FOR DELETE USING ("public"."is_household_admin"("id"));



CREATE POLICY "households_insert_authenticated" ON "public"."households" FOR INSERT WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "created_by"));



CREATE POLICY "households_select_member_or_support" ON "public"."households" FOR SELECT USING ("public"."can_access_household"("id"));



CREATE POLICY "households_update_admin" ON "public"."households" FOR UPDATE USING ("public"."is_household_admin"("id")) WITH CHECK ("public"."is_household_admin"("id"));



ALTER TABLE "public"."kv_store_e874fae9" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_select_own" ON "public"."profiles" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "id"));



CREATE POLICY "profiles_select_support" ON "public"."profiles" FOR SELECT USING ("public"."is_support_user"());



CREATE POLICY "profiles_update_own" ON "public"."profiles" FOR UPDATE USING ((( SELECT "auth"."uid"() AS "uid") = "id")) WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "id"));



ALTER TABLE "public"."support_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "support_audit_select_own" ON "public"."support_audit_log" FOR SELECT USING ((( SELECT "auth"."uid"() AS "uid") = "support_user_id"));



ALTER TABLE "public"."support_users" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."can_access_household"("_household_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."can_access_household"("_household_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_access_household"("_household_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_household_admin"("_household_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_household_admin"("_household_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_household_admin"("_household_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_household_member"("_household_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_household_member"("_household_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_household_member"("_household_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_support_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_support_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_support_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "service_role";


















GRANT ALL ON TABLE "public"."agent_audit_log" TO "service_role";
GRANT SELECT ON TABLE "public"."agent_audit_log" TO "authenticated";



GRANT ALL ON TABLE "public"."alerts" TO "anon";
GRANT ALL ON TABLE "public"."alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."alerts" TO "service_role";



GRANT ALL ON TABLE "public"."chores" TO "anon";
GRANT ALL ON TABLE "public"."chores" TO "authenticated";
GRANT ALL ON TABLE "public"."chores" TO "service_role";



GRANT ALL ON TABLE "public"."helpers" TO "anon";
GRANT ALL ON TABLE "public"."helpers" TO "authenticated";
GRANT ALL ON TABLE "public"."helpers" TO "service_role";



GRANT ALL ON TABLE "public"."household_members" TO "anon";
GRANT ALL ON TABLE "public"."household_members" TO "authenticated";
GRANT ALL ON TABLE "public"."household_members" TO "service_role";



GRANT ALL ON TABLE "public"."households" TO "anon";
GRANT ALL ON TABLE "public"."households" TO "authenticated";
GRANT ALL ON TABLE "public"."households" TO "service_role";



GRANT ALL ON TABLE "public"."kv_store_e874fae9" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."support_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."support_users" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";

revoke delete on table "public"."agent_audit_log" from "anon";

revoke insert on table "public"."agent_audit_log" from "anon";

revoke references on table "public"."agent_audit_log" from "anon";

revoke select on table "public"."agent_audit_log" from "anon";

revoke trigger on table "public"."agent_audit_log" from "anon";

revoke truncate on table "public"."agent_audit_log" from "anon";

revoke update on table "public"."agent_audit_log" from "anon";

revoke delete on table "public"."agent_audit_log" from "authenticated";

revoke insert on table "public"."agent_audit_log" from "authenticated";

revoke references on table "public"."agent_audit_log" from "authenticated";

revoke trigger on table "public"."agent_audit_log" from "authenticated";

revoke truncate on table "public"."agent_audit_log" from "authenticated";

revoke update on table "public"."agent_audit_log" from "authenticated";

revoke delete on table "public"."kv_store_e874fae9" from "anon";

revoke insert on table "public"."kv_store_e874fae9" from "anon";

revoke references on table "public"."kv_store_e874fae9" from "anon";

revoke select on table "public"."kv_store_e874fae9" from "anon";

revoke trigger on table "public"."kv_store_e874fae9" from "anon";

revoke truncate on table "public"."kv_store_e874fae9" from "anon";

revoke update on table "public"."kv_store_e874fae9" from "anon";

revoke delete on table "public"."kv_store_e874fae9" from "authenticated";

revoke insert on table "public"."kv_store_e874fae9" from "authenticated";

revoke references on table "public"."kv_store_e874fae9" from "authenticated";

revoke select on table "public"."kv_store_e874fae9" from "authenticated";

revoke trigger on table "public"."kv_store_e874fae9" from "authenticated";

revoke truncate on table "public"."kv_store_e874fae9" from "authenticated";

revoke update on table "public"."kv_store_e874fae9" from "authenticated";

revoke delete on table "public"."support_audit_log" from "anon";

revoke insert on table "public"."support_audit_log" from "anon";

revoke references on table "public"."support_audit_log" from "anon";

revoke select on table "public"."support_audit_log" from "anon";

revoke trigger on table "public"."support_audit_log" from "anon";

revoke truncate on table "public"."support_audit_log" from "anon";

revoke update on table "public"."support_audit_log" from "anon";

revoke delete on table "public"."support_audit_log" from "authenticated";

revoke insert on table "public"."support_audit_log" from "authenticated";

revoke references on table "public"."support_audit_log" from "authenticated";

revoke select on table "public"."support_audit_log" from "authenticated";

revoke trigger on table "public"."support_audit_log" from "authenticated";

revoke truncate on table "public"."support_audit_log" from "authenticated";

revoke update on table "public"."support_audit_log" from "authenticated";

revoke delete on table "public"."support_users" from "anon";

revoke insert on table "public"."support_users" from "anon";

revoke references on table "public"."support_users" from "anon";

revoke select on table "public"."support_users" from "anon";

revoke trigger on table "public"."support_users" from "anon";

revoke truncate on table "public"."support_users" from "anon";

revoke update on table "public"."support_users" from "anon";

revoke delete on table "public"."support_users" from "authenticated";

revoke insert on table "public"."support_users" from "authenticated";

revoke references on table "public"."support_users" from "authenticated";

revoke select on table "public"."support_users" from "authenticated";

revoke trigger on table "public"."support_users" from "authenticated";

revoke truncate on table "public"."support_users" from "authenticated";

revoke update on table "public"."support_users" from "authenticated";

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


