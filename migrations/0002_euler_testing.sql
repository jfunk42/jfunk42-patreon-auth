CREATE TABLE feature_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patreon_user_hash TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  created_at INTEGER NOT NULL
);

CREATE INDEX feature_votes_user_created_at ON feature_votes (patreon_user_hash, created_at);

CREATE TABLE feature_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patreon_user_hash TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX feature_suggestions_user_created_at ON feature_suggestions (patreon_user_hash, created_at);

CREATE TABLE euler_test_limits (
  patreon_user_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('vote', 'suggestion')),
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (patreon_user_hash, action)
);
