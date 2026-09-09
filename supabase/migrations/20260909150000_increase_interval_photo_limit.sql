begin;

alter table public.interval_photos
  drop constraint interval_photos_file_size;
alter table public.interval_photos
  add constraint interval_photos_file_size check (file_size between 1 and 26214400);

update storage.buckets
set file_size_limit = 26214400
where id = 'interval-photos';

commit;
