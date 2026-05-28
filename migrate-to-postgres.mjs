process.env.NODE_ENV = "test";

const { importCsvToPostgres } = await import("./server.mjs");

const result = await importCsvToPostgres({
  truncate: process.argv.includes("--truncate")
});

console.log(`Import completato: ${result.needs} need, ${result.candidates} candidati, ${result.applications} associazioni.`);
