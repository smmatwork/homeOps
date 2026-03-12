select id, email, created_at
from auth.users
where lower(email) = lower('greetsunshine@gmail.com');