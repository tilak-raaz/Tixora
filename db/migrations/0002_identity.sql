-- 0002: identity tables for Better Auth (users, sessions, accounts).
--
-- Better Auth owns the shape of these tables; this file is the hand-written
-- equivalent of its schema with our naming (plural tables, snake_case columns,
-- uuid ids). The mapping lives in apps/api/src/modules/auth/auth.ts, and the
-- integration test "auth schema" fails if the two ever drift apart.
--
-- No verification table: verification tokens live in Redis (secondary storage).

-- Shared trigger function: keeps updated_at current on every UPDATE, including
-- updates made by hand or by our own SQL, not only by Better Auth.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  email          text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image          text,
  -- Admin plugin fields. We use exactly two roles.
  role           text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  banned         boolean DEFAULT false,
  ban_reason     text,
  ban_expires    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One account per email regardless of case (Asha@x.com and asha@x.com are the same person).
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sessions are written to Redis (fast lookups from every replica) and here
-- (durable record; survives a Redis flush). See ADR 0004.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token           text NOT NULL UNIQUE,
  expires_at      timestamptz NOT NULL,
  ip_address      text,
  user_agent      text,
  impersonated_by text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);

CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per way of signing in. For email + password, provider_id = 'credential'
-- and password holds the hash.
CREATE TABLE accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  account_id               text NOT NULL,
  provider_id              text NOT NULL,
  access_token             text,
  refresh_token            text,
  id_token                 text,
  access_token_expires_at  timestamptz,
  refresh_token_expires_at timestamptz,
  scope                    text,
  password                 text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);

CREATE INDEX accounts_user_id_idx ON accounts (user_id);

CREATE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
