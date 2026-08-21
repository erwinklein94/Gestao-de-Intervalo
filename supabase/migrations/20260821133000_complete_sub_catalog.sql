begin;

-- PostgreSQL lpad truncates values longer than the requested width. The first
-- migration therefore inserted 01..99 but collapsed 100..103 into conflicts.
insert into public.subs (code, name, sort_order, source_document, source_page)
select
  'SUB ' || number::text,
  'SUB ' || number::text,
  number,
  'Mapa Rumo 2020-V9 - base SIV atualizada em JAN-2020 (mapa em revisao)',
  1
from generate_series(100, 103) as number
on conflict (code) do nothing;

commit;
