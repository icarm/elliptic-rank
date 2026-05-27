-- Users (identified by an OAuth provider) and their API tokens.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,           -- 'github' (room for more providers)
  provider_user_id TEXT NOT NULL,   -- stable id from the IdP (numeric for GitHub)
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT,
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,  -- sha256(token); the raw token is shown once
  prefix TEXT NOT NULL,             -- e.g. 'erank_abcd1234' for display
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
