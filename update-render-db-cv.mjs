process.env.NODE_ENV = "test";
process.env.DATA_BACKEND = "postgres";

const { pgQuery } = await import("./server.mjs");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL non configurata. Su Render usa l'Internal Database URL del database PostgreSQL.");
  process.exit(1);
}

console.log("Aggiorno il database per la gestione CV candidati...");

await pgQuery(`
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
`);

await pgQuery(`
  CREATE INDEX IF NOT EXISTS idx_candidate_files_candidate_id
  ON candidate_files(candidate_id);
`);

console.log("Aggiornamento completato: tabella candidate_files pronta.");
