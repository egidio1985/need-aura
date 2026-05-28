process.env.NODE_ENV = "test";
process.env.DATA_BACKEND = "csv";
process.env.DATABASE_URL = process.env.ADMIN_DATABASE_URL || "postgres://postgres:admin@localhost:5432/postgres";

const { pgQuery } = await import("./server.mjs");

const dbName = process.env.POSTGRES_DB_NAME || "needs_manager";
const exists = await pgQuery(`SELECT datname FROM pg_database WHERE datname = '${dbName.replace(/'/g, "''")}'`);

if (exists.rows.length) {
  console.log(`Database ${dbName} gia presente.`);
} else {
  await pgQuery(`CREATE DATABASE ${dbName}`);
  console.log(`Database ${dbName} creato.`);
}
