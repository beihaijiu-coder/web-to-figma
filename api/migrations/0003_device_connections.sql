CREATE TABLE connection_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_type text NOT NULL CHECK (client_type IN ('chrome_extension', 'figma_plugin')),
  requested_client_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
  device_code_hash text NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE,
  poll_interval_seconds integer NOT NULL CHECK (poll_interval_seconds BETWEEN 3 AND 60),
  expires_at timestamptz NOT NULL,
  last_polled_at timestamptz,
  approved_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  installation_id uuid UNIQUE REFERENCES installations(id) ON DELETE SET NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  denied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status IN ('approved', 'consumed') AND approved_user_id IS NOT NULL AND installation_id IS NOT NULL AND approved_at IS NOT NULL)
    OR status NOT IN ('approved', 'consumed')
  )
);

CREATE INDEX connection_requests_status_expiry_idx
  ON connection_requests (status, expires_at);

CREATE TABLE refresh_token_families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  client_type text NOT NULL CHECK (client_type IN ('chrome_extension', 'figma_plugin')),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX refresh_token_families_installation_idx
  ON refresh_token_families (installation_id, revoked_at);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES refresh_token_families(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  parent_token_id uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  replaced_by_token_id uuid UNIQUE REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'active' AND used_at IS NULL AND revoked_at IS NULL)
    OR (status = 'used' AND used_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX refresh_tokens_family_status_idx
  ON refresh_tokens (family_id, status);

CREATE TABLE access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  audience text NOT NULL CHECK (audience IN ('chrome_extension', 'figma_plugin')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX access_tokens_hash_idx
  ON access_tokens (token_hash, expires_at)
  WHERE revoked_at IS NULL;
