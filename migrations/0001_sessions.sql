CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX oauth_states_expires_at ON oauth_states (expires_at);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  patreon_user_hash TEXT NOT NULL,
  membership_tier TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_expires_at ON sessions (expires_at);
