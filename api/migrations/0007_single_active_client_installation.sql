-- A reconnect from the same named client replaces its previous token pair.
-- Keep only the most recently used active record for legacy duplicate rows.
ALTER TABLE connection_requests
  DROP CONSTRAINT IF EXISTS connection_requests_installation_id_key;

WITH ranked_installations AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY user_id, client_type, COALESCE(display_name, '')
      ORDER BY last_seen_at DESC, created_at DESC, id DESC
  ) AS position
  FROM installations
  WHERE status = 'active' AND display_name IS NOT NULL
)
UPDATE installations
SET status = 'revoked', revoked_at = now()
WHERE id IN (SELECT id FROM ranked_installations WHERE position > 1);

-- Revoked historical installations must not be able to refresh a session.
UPDATE access_tokens
SET revoked_at = COALESCE(revoked_at, now())
WHERE installation_id IN (SELECT id FROM installations WHERE status = 'revoked');

UPDATE refresh_token_families
SET revoked_at = COALESCE(revoked_at, now()),
    revoke_reason = COALESCE(revoke_reason, 'superseded_duplicate_installation')
WHERE installation_id IN (SELECT id FROM installations WHERE status = 'revoked');

UPDATE refresh_tokens
SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
WHERE family_id IN (
  SELECT id FROM refresh_token_families WHERE revoked_at IS NOT NULL
)
  AND status = 'active';

CREATE UNIQUE INDEX installations_one_active_client_name_idx
  ON installations (user_id, client_type, COALESCE(display_name, ''))
  WHERE status = 'active' AND display_name IS NOT NULL;
