-- Chat memory: persistent conversations, messages, and rolling summaries

create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  scope text not null check (scope in ('user','household')),
  user_id uuid null references auth.users(id) on delete cascade,
  title text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_conversations_household_id_idx
  on public.chat_conversations (household_id);

create index if not exists chat_conversations_user_scope_idx
  on public.chat_conversations (user_id, scope);

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  role text not null check (role in ('system','user','assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_conversation_id_created_at_idx
  on public.chat_messages (conversation_id, created_at);

create table if not exists public.chat_summaries (
  conversation_id uuid primary key references public.chat_conversations(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists chat_summaries_household_id_idx
  on public.chat_summaries (household_id);

alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_summaries enable row level security;

create policy "chat_conversations_select" on public.chat_conversations
  for select
  using (
    public.can_access_household(household_id)
    and (
      scope = 'household'
      or user_id = auth.uid()
    )
  );

create policy "chat_conversations_insert" on public.chat_conversations
  for insert
  with check (
    public.can_access_household(household_id)
    and (
      scope = 'household'
      or user_id = auth.uid()
    )
  );

create policy "chat_conversations_update" on public.chat_conversations
  for update
  using (
    public.can_access_household(household_id)
    and (
      scope = 'household'
      or user_id = auth.uid()
    )
  )
  with check (
    public.can_access_household(household_id)
    and (
      scope = 'household'
      or user_id = auth.uid()
    )
  );

create policy "chat_messages_select" on public.chat_messages
  for select
  using (public.can_access_household(household_id));

create policy "chat_messages_insert" on public.chat_messages
  for insert
  with check (public.can_access_household(household_id));

create policy "chat_summaries_select" on public.chat_summaries
  for select
  using (public.can_access_household(household_id));

create policy "chat_summaries_insert" on public.chat_summaries
  for insert
  with check (public.can_access_household(household_id));

create policy "chat_summaries_update" on public.chat_summaries
  for update
  using (public.can_access_household(household_id))
  with check (public.can_access_household(household_id));

create trigger handle_updated_at_chat_conversations
  before update on public.chat_conversations
  for each row
  execute function public.handle_updated_at();
