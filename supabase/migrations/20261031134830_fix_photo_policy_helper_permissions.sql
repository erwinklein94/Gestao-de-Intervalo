-- Restore EXECUTE only for the two helpers called by photo RLS policies.
-- The helpers still enforce scope, dataset and phase. No business data changes.
grant execute on function private.interval_accepts_any_photo(uuid) to authenticated;
grant execute on function private.interval_accepts_photos(uuid, text) to authenticated;
