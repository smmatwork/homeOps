-- insert into public.households (name, created_by)
-- values ('Local Test Household', 'aa1f184a-9648-47e3-a4a5-32fa940da34b')
-- returning id;


-- insert into public.household_members (household_id, user_id, role)
-- values ('c04aa697-114c-4dfb-8e4c-6dd12b15a429', 'aa1f184a-9648-47e3-a4a5-32fa940da34b', 'admin')
-- on conflict do nothing;

-- select *
-- from public.agent_audit_log
-- order by created_at desc
-- limit 5;

-- select id, email, created_at
-- from auth.users
-- where id = 'e2ee8cca-1ed9-49fb-b151-a8b1da43be2f';
-- select id, email, created_at
-- from auth.users
-- where id = 'e2ee8cca-1ed9-49fb-b151-a8b1da43be2f';
select user_id, role, created_at
from public.household_members
where household_id = '8ffb284a-655f-4f1d-938d-1b273debfc02'
order by created_at desc;
select au.id, au.email, hm.household_id, hm.role
from public.household_members hm
join auth.users au on au.id = hm.user_id
where hm.household_id = '8ffb284a-655f-4f1d-938d-1b273debfc02';