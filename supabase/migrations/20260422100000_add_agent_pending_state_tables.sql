-- DB-backed pending confirmations + clarifications for the agent-service
-- orchestrator. Replaces the in-process dict store so a service restart
-- mid-conversation doesn't orphan the user's reply.
--
-- See orchestrator/state.py in agent-service — PendingStore abstraction
-- picks between the legacy in-process store (default) and this DB-backed
-- store via AGENT_PENDING_STORE=supabase.
--
-- Two tables keyed by conversation_id (rows are recycled across
-- conversations; we just overwrite on re-stash). Payloads are JSONB so the
-- ExtractedIntent / tool_calls / match_ids structures serialize cleanly
-- without a schema migration each time agent state evolves.

CREATE TABLE IF NOT EXISTS agent_pending_confirmations (
    conversation_id TEXT PRIMARY KEY,
    intent JSONB NOT NULL,
    match_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- sync-followup fields (null for a regular confirmation)
    sync_field TEXT,
    sync_chore_ids JSONB,
    sync_default_value TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_pending_confirmations_expires_idx
    ON agent_pending_confirmations (expires_at);

CREATE TABLE IF NOT EXISTS agent_pending_clarifications (
    conversation_id TEXT PRIMARY KEY,
    original_intents JSONB NOT NULL,
    failed_match_text TEXT NOT NULL,
    question_type TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_pending_clarifications_expires_idx
    ON agent_pending_clarifications (expires_at);

-- Service-role only; the agent-service is the sole writer. Reads go through
-- the agent-service's own service-role key so no anon-role policies needed.
ALTER TABLE agent_pending_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_pending_clarifications ENABLE ROW LEVEL SECURITY;


-- ── Confirmation RPCs ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION agent_stash_confirmation(
    p_conversation_id TEXT,
    p_intent JSONB,
    p_match_ids JSONB,
    p_tool_calls JSONB,
    p_ttl_seconds INTEGER,
    p_sync_field TEXT DEFAULT NULL,
    p_sync_chore_ids JSONB DEFAULT NULL,
    p_sync_default_value TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO agent_pending_confirmations (
        conversation_id, intent, match_ids, tool_calls,
        sync_field, sync_chore_ids, sync_default_value,
        expires_at
    )
    VALUES (
        p_conversation_id, p_intent, COALESCE(p_match_ids, '[]'::jsonb),
        COALESCE(p_tool_calls, '[]'::jsonb),
        p_sync_field, p_sync_chore_ids, p_sync_default_value,
        now() + (p_ttl_seconds || ' seconds')::interval
    )
    ON CONFLICT (conversation_id) DO UPDATE
    SET intent = EXCLUDED.intent,
        match_ids = EXCLUDED.match_ids,
        tool_calls = EXCLUDED.tool_calls,
        sync_field = EXCLUDED.sync_field,
        sync_chore_ids = EXCLUDED.sync_chore_ids,
        sync_default_value = EXCLUDED.sync_default_value,
        expires_at = EXCLUDED.expires_at,
        created_at = now();
END;
$$;


-- Atomic pop: return the row + delete in one statement, returning NULL
-- when missing or expired.
CREATE OR REPLACE FUNCTION agent_take_confirmation(
    p_conversation_id TEXT
) RETURNS TABLE (
    intent JSONB,
    match_ids JSONB,
    tool_calls JSONB,
    sync_field TEXT,
    sync_chore_ids JSONB,
    sync_default_value TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH popped AS (
        DELETE FROM agent_pending_confirmations
        WHERE conversation_id = p_conversation_id
          AND expires_at > now()
        RETURNING
            intent,
            match_ids,
            tool_calls,
            sync_field,
            sync_chore_ids,
            sync_default_value
    )
    SELECT * FROM popped;

    -- Also sweep expired rows for this conv_id so they don't accumulate.
    DELETE FROM agent_pending_confirmations
    WHERE conversation_id = p_conversation_id
      AND expires_at <= now();
END;
$$;


CREATE OR REPLACE FUNCTION agent_clear_confirmation(
    p_conversation_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM agent_pending_confirmations
    WHERE conversation_id = p_conversation_id;
END;
$$;


-- ── Clarification RPCs ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION agent_stash_clarification(
    p_conversation_id TEXT,
    p_original_intents JSONB,
    p_failed_match_text TEXT,
    p_question_type TEXT,
    p_ttl_seconds INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO agent_pending_clarifications (
        conversation_id, original_intents, failed_match_text,
        question_type, expires_at
    )
    VALUES (
        p_conversation_id, p_original_intents, p_failed_match_text,
        p_question_type, now() + (p_ttl_seconds || ' seconds')::interval
    )
    ON CONFLICT (conversation_id) DO UPDATE
    SET original_intents = EXCLUDED.original_intents,
        failed_match_text = EXCLUDED.failed_match_text,
        question_type = EXCLUDED.question_type,
        expires_at = EXCLUDED.expires_at,
        created_at = now();
END;
$$;


CREATE OR REPLACE FUNCTION agent_take_clarification(
    p_conversation_id TEXT
) RETURNS TABLE (
    original_intents JSONB,
    failed_match_text TEXT,
    question_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    WITH popped AS (
        DELETE FROM agent_pending_clarifications
        WHERE conversation_id = p_conversation_id
          AND expires_at > now()
        RETURNING
            original_intents,
            failed_match_text,
            question_type
    )
    SELECT * FROM popped;

    -- Sweep expired rows for this conv_id.
    DELETE FROM agent_pending_clarifications
    WHERE conversation_id = p_conversation_id
      AND expires_at <= now();
END;
$$;


-- Execution perms: service_role only.
GRANT EXECUTE ON FUNCTION
    agent_stash_confirmation(TEXT, JSONB, JSONB, JSONB, INTEGER, TEXT, JSONB, TEXT),
    agent_take_confirmation(TEXT),
    agent_clear_confirmation(TEXT),
    agent_stash_clarification(TEXT, JSONB, TEXT, TEXT, INTEGER),
    agent_take_clarification(TEXT)
TO service_role;
