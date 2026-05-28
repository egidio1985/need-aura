process.env.NODE_ENV = "test";
process.env.DATA_BACKEND = "postgres";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, "uploads"));

const { ensurePostgresSchema, importCsvToPostgres, pgQuery } = await import("./server.mjs");

const shouldImportCsv = process.argv.includes("--import-csv");
const shouldTruncate = process.argv.includes("--truncate");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL non configurata. Su Render usa l'Internal Database URL del database PostgreSQL.");
  process.exit(1);
}

console.log("Preparo schema PostgreSQL...");
await ensurePostgresSchema();

await pgQuery("CREATE INDEX IF NOT EXISTS idx_candidate_files_candidate_id ON candidate_files(candidate_id)");
await fs.mkdir(path.join(uploadsDir, "candidates"), { recursive: true });
console.log(`Cartella upload pronta: ${uploadsDir}`);

if (shouldImportCsv) {
  const result = await importCsvToPostgres({ truncate: shouldTruncate });
  console.log(`Import CSV completato: ${result.needs} need, ${result.candidates} candidati, ${result.applications} associazioni.`);
} else {
  console.log("Import CSV saltato. Usa --import-csv per popolare il DB dai CSV inclusi/configurati.");
}

console.log("Setup Render DB completato.");
