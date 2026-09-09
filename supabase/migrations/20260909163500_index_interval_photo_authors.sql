begin;

create index interval_photos_author_user_idx
  on public.interval_photos(author_user_id, created_at desc);
create index interval_photos_author_member_idx
  on public.interval_photos(author_member_id, created_at desc);

commit;
