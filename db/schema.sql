CREATE TABLE IF NOT EXISTS needs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  fte TEXT,
  client TEXT,
  location TEXT,
  seniority TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  urgency TEXT,
  status TEXT,
  budget TEXT,
  owner TEXT,
  work_mode TEXT,
  description TEXT,
  opened_at TEXT,
  closed_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  skills TEXT[] NOT NULL DEFAULT '{}',
  evaluation TEXT,
  phase TEXT,
  experience_raw TEXT,
  availability TEXT,
  current_ral TEXT,
  contract TEXT,
  desired_ral TEXT,
  source TEXT,
  city TEXT,
  geographic_availability TEXT,
  first_interview_at TEXT,
  qm_at TEXT,
  relocation_city TEXT,
  email TEXT,
  notes TEXT,
  associated_need TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  need_id TEXT NOT NULL REFERENCES needs(id) ON DELETE CASCADE,
  source TEXT,
  phase TEXT,
  associated_at TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, need_id)
);

CREATE TABLE IF NOT EXISTS candidate_files (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes TEXT,
  file_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidates_phase ON candidates(phase);
CREATE INDEX IF NOT EXISTS idx_candidates_source ON candidates(source);
CREATE INDEX IF NOT EXISTS idx_needs_status ON needs(status);
CREATE INDEX IF NOT EXISTS idx_applications_candidate_id ON applications(candidate_id);
CREATE INDEX IF NOT EXISTS idx_applications_need_id ON applications(need_id);
CREATE INDEX IF NOT EXISTS idx_candidate_files_candidate_id ON candidate_files(candidate_id);
