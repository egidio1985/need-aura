import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.DATA_BACKEND = "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  ensurePostgresSchema,
  listNeeds,
  listCandidates,
  listApplications,
  serializeCsv
} = await import("./server.mjs");

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function joinList(value) {
  return Array.isArray(value) ? value.join(", ") : value || "";
}

const exportDir = path.join(__dirname, "exports", `postgres-export-${timestamp()}`);
await fs.mkdir(exportDir, { recursive: true });

await ensurePostgresSchema();

const [needs, candidates, applications] = await Promise.all([
  listNeeds(),
  listCandidates(),
  listApplications()
]);

const needHeaders = [
  "ID",
  "Titolo",
  "FTE ricercate",
  "Cliente",
  "Sede",
  "Seniority",
  "Skills",
  "Urgenza",
  "Stato",
  "Budget",
  "Owner",
  "Modalita lavoro",
  "Descrizione Job",
  "Data Apertura Need",
  "Data Chiusura Need"
];

const candidateHeaders = [
  "ID",
  "Nome",
  "Ruolo",
  "Skills",
  "Valutazione",
  "Fase Processo",
  "Anni esperienza",
  "Disponibilita",
  "RAL attuale",
  "Inquadramento",
  "RAL desiderata",
  "Fornitore CV",
  "Citta",
  "Disponibilita geografica",
  "Data Primo Colloquio",
  "Data QM",
  "Citta trasferimento",
  "Email",
  "Note BM",
  "Need Associato",
  "Descrizione"
];

const applicationHeaders = [
  "ID",
  "Candidate Id",
  "Candidate",
  "Need Id",
  "Need",
  "Fornitore CV",
  "Fase Processo",
  "Data Associazione",
  "Note"
];

const needRows = needs.map((need) => ({
  ID: need.id,
  Titolo: need.title,
  "FTE ricercate": need.fte,
  Cliente: need.client,
  Sede: need.location,
  Seniority: need.seniority,
  Skills: joinList(need.skills),
  Urgenza: need.urgency,
  Stato: need.status,
  Budget: need.budget,
  Owner: need.owner,
  "Modalita lavoro": need.workMode,
  "Descrizione Job": need.description,
  "Data Apertura Need": need.openedAt,
  "Data Chiusura Need": need.closedAt
}));

const candidateRows = candidates.map((candidate) => ({
  ID: candidate.id,
  Nome: candidate.name,
  Ruolo: candidate.role,
  Skills: joinList(candidate.skills),
  Valutazione: candidate.evaluation,
  "Fase Processo": candidate.phase,
  "Anni esperienza": candidate.experienceRaw,
  Disponibilita: candidate.availability,
  "RAL attuale": candidate.currentRal,
  Inquadramento: candidate.contract,
  "RAL desiderata": candidate.desiredRal,
  "Fornitore CV": candidate.source,
  Citta: candidate.city,
  "Disponibilita geografica": candidate.geographicAvailability,
  "Data Primo Colloquio": candidate.firstInterviewAt,
  "Data QM": candidate.qmAt,
  "Citta trasferimento": candidate.relocationCity,
  Email: candidate.email,
  "Note BM": candidate.notes,
  "Need Associato": candidate.associatedNeed,
  Descrizione: candidate.description
}));

const applicationRows = applications.map((application) => ({
  ID: application.id,
  "Candidate Id": application.candidateId,
  Candidate: application.candidateName,
  "Need Id": application.needId,
  Need: application.needTitle,
  "Fornitore CV": application.source,
  "Fase Processo": application.phase,
  "Data Associazione": application.associatedAt,
  Note: application.notes
}));

await Promise.all([
  fs.writeFile(path.join(exportDir, "needs.csv"), serializeCsv(needHeaders, needRows), "utf8"),
  fs.writeFile(path.join(exportDir, "candidates.csv"), serializeCsv(candidateHeaders, candidateRows), "utf8"),
  fs.writeFile(path.join(exportDir, "applications.csv"), serializeCsv(applicationHeaders, applicationRows), "utf8"),
  fs.writeFile(path.join(exportDir, "database.json"), JSON.stringify({ needs, candidates, applications }, null, 2), "utf8")
]);

console.log(`Export PostgreSQL completato in: ${exportDir}`);
console.log(`${needs.length} need, ${candidates.length} candidati, ${applications.length} associazioni esportati.`);
