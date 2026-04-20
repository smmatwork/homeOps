CREATE UNIQUE INDEX IF NOT EXISTS recipes_source_url_uniq
ON public.recipes (lower(source_url))
WHERE source_url IS NOT NULL;
