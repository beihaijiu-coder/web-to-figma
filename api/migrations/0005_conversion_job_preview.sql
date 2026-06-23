ALTER TABLE conversion_jobs
  ADD COLUMN source_url text,
  ADD COLUMN source_title text,
  ADD COLUMN preview_image_data_url text;

ALTER TABLE conversion_jobs
  ADD CONSTRAINT conversion_jobs_preview_image_data_url_format
  CHECK (
    preview_image_data_url IS NULL
    OR preview_image_data_url ~ '^data:image/(png|jpeg|jpg|webp);base64,'
  );
