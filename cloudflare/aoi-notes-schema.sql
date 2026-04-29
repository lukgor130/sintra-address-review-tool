CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_pack_slug
  ON sessions(pack_id, slug);

CREATE TABLE IF NOT EXISTS parcel_feedback (
  session_id TEXT NOT NULL,
  parcel_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, parcel_id)
);

CREATE INDEX IF NOT EXISTS idx_parcel_feedback_session
  ON parcel_feedback(session_id);
