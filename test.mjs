import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "needs-manager-"));
const needsFixture = path.join(temp, "NeedsManager_Needs.csv");
const candidatesFixture = path.join(temp, "NeedsManager_Candidates.csv");
const applicationsFixture = path.join(temp, "NeedsManager_Applications.csv");

await fs.copyFile(path.join(root, "data", "NeedsManager_Needs.csv"), needsFixture);
await fs.copyFile(path.join(root, "data", "NeedsManager_Candidates.csv"), candidatesFixture);

process.env.NODE_ENV = "test";
process.env.DATA_BACKEND = "csv";
process.env.NEEDS_CSV_PATH = needsFixture;
process.env.CANDIDATES_CSV_PATH = candidatesFixture;
process.env.APPLICATIONS_CSV_PATH = applicationsFixture;

const mod = await import(`file:///${path.join(root, "server.mjs").replace(/\\/g, "/")}`);

const needs = await mod.listNeeds();
const candidates = await mod.listCandidates();
const applications = await mod.listApplications();

assert.ok(needs.length >= 19, "deve leggere i need dal CSV vivo");
assert.ok(candidates.length >= 31, "deve leggere i candidati dal CSV vivo");
assert.ok(applications.length >= 1, "deve creare/leggere le associazioni application");
assert.ok(needs[0].title, "il primo need deve avere un titolo");
assert.ok(candidates[0].name, "il primo candidato deve avere un nome");

const labviewNeed = needs.find((need) => /labview/i.test(need.title));
assert.ok(labviewNeed, "deve trovare un need LabView");
const matches = candidates
  .filter((candidate) => {
    const phase = String(candidate.phase || "").toLowerCase();
    const evaluation = String(candidate.evaluation || "").toLowerCase();
    return evaluation !== "c" && !["ko bm", "ko cliente", "ko candidato"].includes(phase);
  })
  .map((candidate) => mod.scoreCandidateForNeed(candidate, labviewNeed))
  .sort((a, b) => b.score - a.score);

assert.ok(matches[0].score >= 0 && matches[0].score <= 100, "score nel range 0-100");
assert.ok("positives" in matches[0], "il match deve includere motivazioni positive");
assert.ok("warnings" in matches[0], "il match deve includere warning");
assert.ok(matches.every((match) => match.candidate.evaluation !== "C"), "il matching non deve mostrare valutazione C");
assert.ok(matches.every((match) => !["KO BM", "KO Cliente", "KO Candidato"].includes(match.candidate.phase)), "il matching non deve mostrare fasi KO escluse");

const dashboard = await mod.dashboard();
assert.equal(dashboard.totalNeeds, needs.length, "dashboard need totali");
assert.equal(dashboard.totalCandidates, candidates.length, "dashboard candidati totali");
assert.equal(dashboard.totalApplications, applications.length, "dashboard application totali");
assert.ok(dashboard.openNeeds >= 1, "dashboard need aperti");
assert.ok(Object.keys(dashboard.candidatesBySource).length >= 1, "dashboard candidati per fornitore");
assert.ok(Object.keys(dashboard.candidateStatusBySource).length >= 1, "dashboard stati per fornitore");
assert.ok(Object.keys(dashboard.candidateStatusByNeed).length >= 1, "dashboard stati per need");
assert.ok(Object.keys(dashboard.proposalsByNeedAndSource).length >= 1, "dashboard proposte per need e fornitore");

const csv = mod.serializeCsv(["A", "B"], [{ A: "uno", B: "due, tre" }]);
assert.deepEqual(mod.parseCsv(csv).records, [{ A: "uno", B: "due, tre" }], "roundtrip CSV con virgole");

console.log("OK: parsing CSV, dashboard e matching verificati.");
