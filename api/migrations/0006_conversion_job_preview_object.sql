ALTER TABLE conversion_jobs
  ADD COLUMN preview_object_key text,
  ADD COLUMN preview_deleted_at timestamptz;

ALTER TABLE conversion_jobs
  ADD CONSTRAINT conversion_jobs_preview_object_key_format
  CHECK (
    preview_object_key IS NULL
    OR preview_object_key ~ '^conversion-jobs/[0-9a-f-]+/preview\.(jpg|png|webp)$'
  );

CREATE UNIQUE INDEX conversion_jobs_preview_object_key_unique
  ON conversion_jobs (preview_object_key)
  WHERE preview_object_key IS NOT NULL;
