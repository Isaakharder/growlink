alter table public.varieties
add column if not exists color text not null default 'red';

alter table public.varieties
drop constraint if exists varieties_color_check;

alter table public.varieties
add constraint varieties_color_check
check (color in ('red', 'orange', 'yellow', 'green'));
