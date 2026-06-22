ALTER TABLE conversion_jobs
  ADD COLUMN package_encryption_key text,
  ADD COLUMN package_deleted_at timestamptz,
  ADD COLUMN package_encryption_algorithm text NOT NULL DEFAULT 'A256GCM'
    CHECK (package_encryption_algorithm = 'A256GCM');

ALTER TABLE conversion_jobs
  ADD CONSTRAINT conversion_jobs_package_encryption_key_format
  CHECK (
    package_encryption_key IS NULL
    OR package_encryption_key ~ '^[A-Za-z0-9_-]{43}$'
  );
