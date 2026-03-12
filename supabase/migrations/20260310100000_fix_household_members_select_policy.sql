ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS household_members_select_member_or_support ON public.household_members;

CREATE POLICY household_members_select_self_or_support
ON public.household_members
FOR SELECT
USING (public.is_support_user() OR user_id = auth.uid());
