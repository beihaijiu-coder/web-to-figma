CREATE TABLE installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_type text NOT NULL CHECK (client_type IN ('chrome_extension', 'figma_plugin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX installations_user_client_idx
  ON installations (user_id, client_type, status);

CREATE TABLE conversion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_installation_id uuid REFERENCES installations(id) ON DELETE SET NULL,
  target_installation_id uuid REFERENCES installations(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (
    status IN (
      'created',
      'quota_reserved',
      'upload_issued',
      'uploaded',
      'claimed',
      'importing',
      'imported',
      'cancelled',
      'capture_failed',
      'upload_expired',
      'import_failed',
      'expired'
    )
  ),
  idempotency_key text NOT NULL,
  object_key text,
  scene_package_version integer,
  package_size_bytes bigint CHECK (package_size_bytes IS NULL OR package_size_bytes >= 0),
  package_sha256 text,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX conversion_jobs_target_status_idx
  ON conversion_jobs (target_installation_id, status, created_at);

CREATE INDEX conversion_jobs_user_status_idx
  ON conversion_jobs (user_id, status, created_at);

CREATE TABLE quota_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversion_job_id uuid NOT NULL UNIQUE REFERENCES conversion_jobs(id) ON DELETE CASCADE,
  product_week date NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'settled', 'released')),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  released_at timestamptz,
  CHECK (
    (status = 'reserved' AND settled_at IS NULL AND released_at IS NULL)
    OR (status = 'settled' AND settled_at IS NOT NULL AND released_at IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND settled_at IS NULL)
  )
);

CREATE INDEX quota_reservations_user_week_status_idx
  ON quota_reservations (user_id, product_week, status);

CREATE TABLE usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversion_job_id uuid NOT NULL UNIQUE REFERENCES conversion_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind = 'completed_conversion'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX usage_events_user_kind_time_idx
  ON usage_events (user_id, kind, occurred_at);
