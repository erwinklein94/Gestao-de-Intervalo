begin;

create policy "Authors delete own photos during execution"
on public.interval_photos for delete to authenticated
using (
  author_user_id = (select auth.uid())
  and private.interval_accepts_comments(plan_id)
);

revoke all on public.interval_photos from authenticated;
grant select, insert, delete on public.interval_photos to authenticated;

comment on policy "Authors delete own photos during execution" on public.interval_photos is
  'O autor pode corrigir um anexo enviado por engano somente enquanto o intervalo permanece em execucao.';

commit;
