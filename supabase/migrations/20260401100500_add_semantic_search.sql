CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.semantic_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(384) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT semantic_index_entity_unique UNIQUE (entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS semantic_index_household_entity_idx ON public.semantic_index (household_id, entity_type);
CREATE INDEX IF NOT EXISTS semantic_index_household_updated_idx ON public.semantic_index (household_id, updated_at DESC);

-- For vector similarity search.
-- Note: ivfflat requires setting lists; we choose a conservative default for local/dev.
CREATE INDEX IF NOT EXISTS semantic_index_embedding_ivfflat_idx
ON public.semantic_index USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE public.semantic_index ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS semantic_index_select_member_or_support ON public.semantic_index;
CREATE POLICY semantic_index_select_member_or_support
ON public.semantic_index
FOR SELECT
USING (public.is_support_user() OR public.is_household_member(household_id));

-- Semantic search RPC
CREATE OR REPLACE FUNCTION public.semantic_search(
  _household_id uuid,
  _query_embedding vector(384),
  _entity_types text[] DEFAULT NULL,
  _match_count integer DEFAULT 10,
  _min_similarity double precision DEFAULT 0.0
)
RETURNS TABLE (
  entity_type text,
  entity_id uuid,
  title text,
  body text,
  metadata jsonb,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  select
    si.entity_type,
    si.entity_id,
    si.title,
    si.body,
    si.metadata,
    (1 - (si.embedding <=> _query_embedding))::double precision as similarity
  from public.semantic_index si
  where si.household_id = _household_id
    and public.can_access_household(_household_id)
    and (_entity_types is null or si.entity_type = any(_entity_types))
    and (1 - (si.embedding <=> _query_embedding)) >= _min_similarity
  order by si.embedding <=> _query_embedding
  limit greatest(1, least(_match_count, 50));
$$;

GRANT EXECUTE ON FUNCTION public.semantic_search(uuid, vector(384), text[], integer, double precision) TO authenticated;
GRANT EXECUTE ON FUNCTION public.semantic_search(uuid, vector(384), text[], integer, double precision) TO service_role;
