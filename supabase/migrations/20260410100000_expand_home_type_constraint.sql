-- Expand home_type constraint to support all new home categories:
-- penthouse, villa_with_pool, independent_house (in addition to existing apartment/villa).

alter table public.home_profiles
  drop constraint if exists home_profiles_home_type_check;

alter table public.home_profiles
  add constraint home_profiles_home_type_check
  check (home_type = any(array[
    'apartment',
    'villa',
    'penthouse',
    'villa_with_pool',
    'independent_house'
  ]));
