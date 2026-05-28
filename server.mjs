import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

function uploadsRoot() {
  return path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, "uploads"));
}

function resolveUploadPath(filePath) {
  if (path.isAbsolute(filePath)) return path.resolve(filePath);
  return path.resolve(path.join(uploadsRoot(), filePath));
}

function allowedUploadRoots() {
  return [uploadsRoot(), path.resolve(path.join(__dirname, "uploads"))];
}

const DEFAULT_NEEDS = path.join(__dirname, "data", "NeedsManager_Needs.csv");//"C:\\Users\\cesco\\Downloads\\NeedsManager_Needs.csv";
const DEFAULT_CANDIDATES = path.join(__dirname, "data", "NeedsManager_Candidates.csv");//"C:\\Users\\cesco\\Downloads\\NeedsManager_Candidates.csv";
const DEFAULT_APPLICATIONS = path.join(__dirname, "data", "NeedsManager_Applications.csv");

const NEED_COLUMNS = [
  "Title",
  "FTE ricercate",
  "Cliente",
  "Sede",
  "Seniority",
  "Skills",
  "Urgenza",
  "Stato",
  "Budget",
  "Owner",
  "Modalità lavoro",
  "Descrizione Job",
  "Data Apertura Need",
  "Data Chiusura Need"
];

const CANDIDATE_COLUMNS = [
  "Title",
  "Ruolo",
  "Skills",
  "Valutazione",
  "Fase Processo",
  "Annid di esperienza",
  "Disponibilita",
  "Ral attuale",
  "Inquadramento",
  "Ral Desiderata",
  "Fornitore CV",
  "Citta",
  "Disponibilità geografica",
  "Data Primo Colloquio",
  "Data QM",
  "Città dove vuole trasferirsi",
  "Email",
  "Note BM",
  "Need Associato",
  "Descrizione Candidato"
];

const APPLICATION_COLUMNS = [
  "Candidate Id",
  "Candidate",
  "Need Id",
  "Need",
  "Fornitore CV",
  "Fase Processo",
  "Data Associazione",
  "Note"
];

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  return fs.readFile(envPath, "utf8")
    .then((text) => {
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const splitAt = line.indexOf("=");
        if (splitAt === -1) continue;
        const key = line.slice(0, splitAt).trim();
        const value = line.slice(splitAt + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = value;
      }
    })
    .catch(() => {});
}

function csvPath(kind) {
  if (kind === "needs") return process.env.NEEDS_CSV_PATH || DEFAULT_NEEDS;
  if (kind === "applications") return process.env.APPLICATIONS_CSV_PATH || DEFAULT_APPLICATIONS;
  return process.env.CANDIDATES_CSV_PATH || DEFAULT_CANDIDATES;
}

function csvList(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function smtpConfig() {
  const recipients = csvList(process.env.NOTIFICATION_TO || process.env.CANDIDATE_NOTIFICATION_TO);
  if (!recipients.length) return null;
  return {
    host: process.env.SMTP_HOST || "",
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    startTls: String(process.env.SMTP_STARTTLS || "true").toLowerCase() !== "false",
    tlsServername: process.env.SMTP_TLS_SERVERNAME || process.env.SMTP_HOST || "",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.NOTIFICATION_FROM || process.env.CANDIDATE_NOTIFICATION_FROM || process.env.SMTP_USER || "",
    recipients
  };
}

function base64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function mailDate() {
  return new Date().toUTCString();
}

function mailText(value) {
  return String(value || "")
    .replace(/\r?\n/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function candidateNotificationMessage(candidate) {
  const subject = `Nuovo candidato inserito: ${candidate.name || "senza nome"}`;
  const lines = [
    `È stato inserito il candidato ${candidate.name || "senza nome"}.`
  ];
  return { subject, body: lines.join("\r\n") };
}

function needNotificationMessage(need) {
  const subject = `Nuovo need inserito: ${need.title || "senza titolo"}`;
  const lines = [
    `È stato inserito un nuovo need: ${need.title || "senza titolo"}.`,
    "",
    `Cliente: ${need.client || "-"}`,
    `Sede: ${need.location || "-"}`,
    `FTE: ${need.fte || "-"}`,
    `Urgenza: ${need.urgency || "-"}`,
    `Owner: ${need.owner || "-"}`
  ];
  return { subject, body: lines.join("\r\n") };
}

function testNotificationMessage() {
  return {
    subject: "Test notifiche Candidate & Needs Manager",
    body: [
      "Questa è una mail di test dal Candidate & Needs Manager.",
      "",
      "Se la ricevi, la configurazione SMTP e i destinatari sono corretti."
    ].join("\r\n")
  };
}

function smtpRead(socket) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || "";
      if (/^\d{3} /.test(last)) {
        socket.off("data", onData);
        socket.off("error", onError);
        resolve({ code: Number(last.slice(0, 3)), text: buffer });
      }
    };
    const onError = (error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

async function smtpExpect(socket, command, expectedCodes) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpRead(socket);
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`SMTP ${response.code}: ${response.text.trim()}`);
  }
  return response;
}

function smtpConnect(config) {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tls.connect(config.port, config.host, { servername: config.tlsServername }, () => resolve(socket))
      : net.connect(config.port, config.host, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function sendSmtpMail(config, message) {
  if (!config.host || !config.from) {
    throw new Error("Configura SMTP_HOST e NOTIFICATION_FROM/SMTP_USER per inviare le mail.");
  }

  let socket = await smtpConnect(config);
  try {
    await smtpExpect(socket, null, [220]);
    await smtpExpect(socket, `EHLO ${process.env.COMPUTERNAME || "localhost"}`, [250]);

    if (!config.secure && config.startTls) {
      await smtpExpect(socket, "STARTTLS", [220]);
      socket = tls.connect({ socket, servername: config.tlsServername });
      await new Promise((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      await smtpExpect(socket, `EHLO ${process.env.COMPUTERNAME || "localhost"}`, [250]);
    }

    if (config.user && config.pass) {
      await smtpExpect(socket, `AUTH PLAIN ${base64(`\0${config.user}\0${config.pass}`)}`, [235]);
    }

    await smtpExpect(socket, `MAIL FROM:<${config.from}>`, [250]);
    for (const recipient of config.recipients) {
      await smtpExpect(socket, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await smtpExpect(socket, "DATA", [354]);

    const body = message.body.replace(/^\./gm, "..");
    socket.write([
      `From: ${config.from}`,
      `To: ${config.recipients.join(", ")}`,
      `Subject: ${mailText(message.subject)}`,
      `Date: ${mailDate()}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      "."
    ].join("\r\n") + "\r\n");
    await smtpExpect(socket, null, [250]);
    await smtpExpect(socket, "QUIT", [221]);
  } finally {
    socket.end();
  }
}

async function notifyCandidateCreated(candidate) {
  const config = smtpConfig();
  if (!config) return { enabled: false, sent: false, recipients: [] };
  try {
    await sendSmtpMail(config, candidateNotificationMessage(candidate));
    return { enabled: true, sent: true, recipients: config.recipients };
  } catch (error) {
    console.error("Invio mail nuovo candidato non riuscito:", error.message);
    return { enabled: true, sent: false, recipients: config.recipients, error: error.message };
  }
}

async function notifyNeedCreated(need) {
  const config = smtpConfig();
  if (!config) return { enabled: false, sent: false, recipients: [] };
  try {
    await sendSmtpMail(config, needNotificationMessage(need));
    return { enabled: true, sent: true, recipients: config.recipients };
  } catch (error) {
    console.error("Invio mail nuovo need non riuscito:", error.message);
    return { enabled: true, sent: false, recipients: config.recipients, error: error.message };
  }
}

async function sendTestNotificationMail() {
  const config = smtpConfig();
  if (!config) {
    throw new Error("Configura NOTIFICATION_TO o CANDIDATE_NOTIFICATION_TO in .env.");
  }
  await sendSmtpMail(config, testNotificationMessage());
  return { sent: true, recipients: config.recipients };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);

  const headers = rows.shift() || [];
  const records = rows.map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? "";
    });
    return record;
  });

  return { headers, records };
}

function serializeCsv(headers, records) {
  const escape = (value) => {
    const text = String(value ?? "");
    const escaped = text.replace(/"/g, "\"\"");
    return `"${escaped}"`;
  };
  const lines = [headers.map(escape).join(",")];
  for (const record of records) {
    lines.push(headers.map((header) => escape(record[header])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function readCsv(kind) {
  const target = csvPath(kind);
  await ensureCsvExists(kind, target);
  const text = await fs.readFile(target, "utf8");
  const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
  const fallback = kind === "needs" ? NEED_COLUMNS : kind === "applications" ? APPLICATION_COLUMNS : CANDIDATE_COLUMNS;
  const headers = parsed.headers.length ? parsed.headers : fallback;
  return { path: target, headers, records: parsed.records };
}

async function ensureCsvExists(kind, target) {
  try {
    await fs.access(target);
  } catch {
    const headers = kind === "needs" ? NEED_COLUMNS : kind === "applications" ? APPLICATION_COLUMNS : CANDIDATE_COLUMNS;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, serializeCsv(headers, []), "utf8");
  }
}

async function writeCsv(kind, headers, records) {
  const target = csvPath(kind);
  const dir = path.dirname(target);
  const backupDir = path.join(dir, ".needs-manager-backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${path.basename(target, ".csv")}-${stamp}.csv`;
  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(target, path.join(backupDir, backupName));
  await fs.writeFile(target, serializeCsv(headers, records), "utf8");
  return { backup: path.join(backupDir, backupName) };
}

function usePostgres() {
  return String(process.env.DATA_BACKEND || "postgres").toLowerCase() !== "csv";
}

function databaseUrl() {
  return process.env.DATABASE_URL || "postgres://postgres:admin@localhost:5432/needs_manager";
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function allowedOrigin() {
  return process.env.ALLOWED_ORIGIN || "*";
}

function parseDatabaseUrl(urlText = databaseUrl()) {
  const url = new URL(urlText);
  return {
    host: url.hostname || "localhost",
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username || "postgres"),
    password: decodeURIComponent(url.password || ""),
    database: decodeURIComponent(url.pathname.replace(/^\//, "") || "needs_manager")
  };
}

function cstring(buffer, offset = 0) {
  const end = buffer.indexOf(0, offset);
  return [buffer.subarray(offset, end).toString("utf8"), end + 1];
}

function writeCString(parts, value) {
  parts.push(Buffer.from(String(value), "utf8"), Buffer.from([0]));
}

function pgMessage(type, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(1 + 4 + payload.length);
  out.write(type, 0);
  out.writeInt32BE(payload.length + 4, 1);
  payload.copy(out, 5);
  return out;
}

function startupMessage(config) {
  const parts = [];
  const header = Buffer.alloc(4);
  header.writeInt32BE(196608, 0);
  parts.push(header);
  writeCString(parts, "user");
  writeCString(parts, config.user);
  writeCString(parts, "database");
  writeCString(parts, config.database);
  writeCString(parts, "client_encoding");
  writeCString(parts, "UTF8");
  parts.push(Buffer.from([0]));
  const payload = Buffer.concat(parts);
  const out = Buffer.alloc(4 + payload.length);
  out.writeInt32BE(out.length, 0);
  payload.copy(out, 4);
  return out;
}

function md5Password(user, password, salt) {
  const inner = crypto.createHash("md5").update(`${password}${user}`).digest("hex");
  return `md5${crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner), salt])).digest("hex")}`;
}

function saslInitial(user) {
  const nonce = crypto.randomBytes(18).toString("base64");
  const bare = `n=${String(user).replace(/=/g, "=3D").replace(/,/g, "=2C")},r=${nonce}`;
  const first = `n,,${bare}`;
  const mechanism = Buffer.from("SCRAM-SHA-256\0", "utf8");
  const response = Buffer.from(first, "utf8");
  const responseLength = Buffer.alloc(4);
  responseLength.writeInt32BE(response.length, 0);
  return {
    nonce,
    bare,
    message: pgMessage("p", Buffer.concat([mechanism, responseLength, response]))
  };
}

function parseScramAttributes(text) {
  const out = {};
  for (const part of text.split(",")) out[part[0]] = part.slice(2);
  return out;
}

function saslFinal(password, firstBare, serverFirst) {
  const attrs = parseScramAttributes(serverFirst);
  const noProof = `c=biws,r=${attrs.r}`;
  const authMessage = `${firstBare},${serverFirst},${noProof}`;
  const salted = crypto.pbkdf2Sync(password, Buffer.from(attrs.s, "base64"), Number(attrs.i), 32, "sha256");
  const clientKey = crypto.createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();
  const signature = crypto.createHmac("sha256", storedKey).update(authMessage).digest();
  const proof = Buffer.alloc(clientKey.length);
  for (let i = 0; i < clientKey.length; i += 1) proof[i] = clientKey[i] ^ signature[i];
  return pgMessage("p", Buffer.from(`${noProof},p=${proof.toString("base64")}`, "utf8"));
}

class PgConnection {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.messages = [];
    this.fields = [];
    this.rows = [];
  }

  async connect() {
    this.socket = net.createConnection({ host: this.config.host, port: this.config.port });
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (error) => this.fail(error));
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.socket.write(startupMessage(this.config));
    let scram = null;
    while (true) {
      const message = await this.nextMessage();
      if (message.type === "R") {
        const code = message.payload.readInt32BE(0);
        if (code === 0) continue;
        if (code === 3) {
          this.socket.write(pgMessage("p", Buffer.from(`${this.config.password}\0`, "utf8")));
          continue;
        }
        if (code === 5) {
          this.socket.write(pgMessage("p", Buffer.from(`${md5Password(this.config.user, this.config.password, message.payload.subarray(4, 8))}\0`, "utf8")));
          continue;
        }
        if (code === 10) {
          scram = saslInitial(this.config.user);
          this.socket.write(scram.message);
          continue;
        }
        if (code === 11) {
          const serverFirst = message.payload.subarray(4).toString("utf8");
          this.socket.write(saslFinal(this.config.password, scram.bare, serverFirst));
          continue;
        }
        if (code === 12) continue;
        throw new Error(`Autenticazione PostgreSQL non supportata: ${code}`);
      }
      if (message.type === "E") throw new Error(this.parseError(message.payload));
      if (message.type === "Z") return;
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < 1 + length) return;
      const message = {
        type: this.buffer.subarray(0, 1).toString("utf8"),
        payload: this.buffer.subarray(5, 1 + length)
      };
      this.buffer = this.buffer.subarray(1 + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.messages.push(message);
    }
  }

  fail(error) {
    while (this.waiters.length) this.waiters.shift().reject(error);
  }

  nextMessage() {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  parseError(payload) {
    let offset = 0;
    const parts = [];
    while (offset < payload.length && payload[offset] !== 0) {
      const key = String.fromCharCode(payload[offset]);
      const [value, next] = cstring(payload, offset + 1);
      if (key === "M" || key === "D" || key === "H") parts.push(value);
      offset = next;
    }
    return parts.join(" ");
  }

  parseRowDescription(payload) {
    let offset = 2;
    const count = payload.readInt16BE(0);
    this.fields = [];
    for (let i = 0; i < count; i += 1) {
      const [name, next] = cstring(payload, offset);
      offset = next + 18;
      this.fields.push(name);
    }
  }

  parseDataRow(payload) {
    let offset = 2;
    const count = payload.readInt16BE(0);
    const row = {};
    for (let i = 0; i < count; i += 1) {
      const length = payload.readInt32BE(offset);
      offset += 4;
      row[this.fields[i]] = length === -1 ? null : payload.subarray(offset, offset + length).toString("utf8");
      if (length > -1) offset += length;
    }
    this.rows.push(row);
  }

  async query(sql) {
    this.fields = [];
    this.rows = [];
    this.socket.write(pgMessage("Q", Buffer.from(`${sql}\0`, "utf8")));
    while (true) {
      const message = await this.nextMessage();
      if (message.type === "T") this.parseRowDescription(message.payload);
      else if (message.type === "D") this.parseDataRow(message.payload);
      else if (message.type === "E") throw new Error(this.parseError(message.payload));
      else if (message.type === "Z") return { rows: this.rows };
    }
  }

  close() {
    if (this.socket) this.socket.end(pgMessage("X"));
  }
}

async function pgQuery(sql) {
  const connection = new PgConnection(parseDatabaseUrl());
  await connection.connect();
  try {
    return await connection.query(sql);
  } finally {
    connection.close();
  }
}

function sqlValue(value) {
  if (value == null || value === "") return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlTextArray(values) {
  const arr = Array.isArray(values) ? values : splitList(values);
  return `ARRAY[${arr.map(sqlValue).join(", ")}]::text[]`;
}

function safeFilename(value) {
  const cleaned = String(value || "file")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "file";
}

function candidateFileRow(row) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    name: row.original_name || row.stored_name || "file",
    mimeType: row.mime_type || "application/octet-stream",
    size: Number(row.size_bytes || 0),
    downloadUrl: `/api/candidate-files/${encodeURIComponent(row.id)}/download`,
    createdAt: row.created_at || ""
  };
}

async function ensurePostgresSchema() {
  await pgQuery(`
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
  `);
}

function makeId(prefix, index, title) {
  const slug = String(title || "senza-titolo")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `${prefix}-${index + 1}-${slug || "record"}`;
}

function indexFromId(id) {
  const match = String(id || "").match(/^[NC]-(\d+)-/);
  if (!match) return -1;
  return Number(match[1]) - 1;
}

function splitList(value) {
  return String(value || "")
    .split(/[;,|]+| - |\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getField(record, aliases) {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(record, alias)) return record[alias] || "";
  }
  return "";
}

function setField(record, aliases, canonical, value) {
  const existing = aliases.find((alias) => Object.prototype.hasOwnProperty.call(record, alias));
  record[existing || canonical] = value;
}

function normalizeToken(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim();
}

const GENERIC_MATCH_WORDS = new Set([
  "ing",
  "ingegnere",
  "ingegneria",
  "engineer",
  "developer",
  "sviluppatore",
  "sviluppatrice",
  "sviluppo",
  "software",
  "profilo",
  "figura",
  "figure",
  "cliente",
  "progetto"
]);

const SKILL_SYNONYMS = new Map([
  ["js", ["javascript", "node", "nodejs", "react"]],
  ["javascript", ["js", "node", "nodejs", "react"]],
  ["node", ["nodejs", "javascript", "backend"]],
  ["nodejs", ["node", "javascript", "backend"]],
  ["c sharp", ["c#", ".net", "dotnet"]],
  ["c#", ["c sharp", ".net", "dotnet"]],
  [".net", ["dotnet", "c#", "c sharp"]],
  ["dotnet", [".net", "c#", "c sharp"]],
  ["sql", ["postgres", "postgresql", "mysql", "database", "db"]],
  ["postgresql", ["postgres", "sql", "database"]],
  ["postgres", ["postgresql", "sql", "database"]],
  ["labview", ["lab view", "ni", "national instruments"]],
  ["plc", ["automazione", "automation", "scada"]],
  ["qa", ["quality assurance", "test", "testing", "collaudo"]],
  ["testing", ["test", "qa", "collaudo", "validazione"]],
  ["test", ["testing", "qa", "collaudo", "validazione"]],
  ["python", ["py", "scripting", "script"]],
  ["java", ["spring", "j2ee"]],
  ["spring", ["java", "springboot", "spring boot"]],
  ["embedded", ["firmware", "microcontrollori", "rtos"]],
  ["firmware", ["embedded", "microcontrollori", "rtos"]]
]);

function words(value) {
  return normalizeToken(value)
    .split(/\s+/)
    .map((word) => word.replace(/\.$/, ""))
    .filter((word) => word.length > 2 && !GENERIC_MATCH_WORDS.has(word));
}

function tokenOverlap(left, right) {
  const rightTokens = new Set(words(right));
  return words(left).filter((word) => rightTokens.has(word));
}

function expandedSkillTerms(skill) {
  const normalized = normalizeToken(skill);
  return [normalized, ...(SKILL_SYNONYMS.get(normalized) || [])].filter(Boolean);
}

function skillMatchesCandidate(neededSkill, candidateSkillTokens, candidateText) {
  for (const term of expandedSkillTerms(neededSkill)) {
    if (candidateSkillTokens.some((skill) => skill === term || skill.includes(term) || term.includes(skill))) return "direct";
    if (candidateText.includes(term)) return "text";
    if (tokenOverlap(term, candidateText).length) return "partial";
  }
  return "";
}

function parseNumber(value) {
  const text = String(value || "").replace(/\./g, "").replace(",", ".");
  const match = text.match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseBudgetMax(value) {
  const text = String(value || "").replace(/\./g, "");
  const numbers = [...text.matchAll(/\d+(?:[,.]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
  if (!numbers.length) return null;
  return Math.max(...numbers);
}

function mapNeed(record, index) {
  const title = getField(record, ["Title", "Titolo"]);
  return {
    id: makeId("N", index, title),
    rowIndex: index,
    title,
    fte: getField(record, ["FTE ricercate"]),
    client: getField(record, ["Cliente"]),
    location: getField(record, ["Sede"]),
    seniority: getField(record, ["Seniority"]),
    skills: splitList(getField(record, ["Skills"])),
    urgency: getField(record, ["Urgenza"]),
    status: getField(record, ["Stato"]),
    budget: getField(record, ["Budget"]),
    owner: getField(record, ["Owner"]),
    workMode: getField(record, ["Modalità lavoro", "ModalitÃ  lavoro"]),
    description: getField(record, ["Descrizione Job"]),
    openedAt: getField(record, ["Data Apertura Need"]),
    closedAt: getField(record, ["Data Chiusura Need"]),
    raw: record
  };
}

function mapCandidate(record, index) {
  const title = getField(record, ["Title", "Nome e Cognome", "Nome", "Candidato"]);
  return {
    id: makeId("C", index, title),
    rowIndex: index,
    name: title,
    role: getField(record, ["Ruolo"]),
    skills: splitList(getField(record, ["Skills"])),
    evaluation: getField(record, ["Valutazione"]),
    phase: getField(record, ["Fase Processo"]),
    experienceYears: parseNumber(getField(record, ["Annid di esperienza", "Anni di esperienza"])),
    experienceRaw: getField(record, ["Annid di esperienza", "Anni di esperienza"]),
    availability: getField(record, ["Disponibilita", "Disponibilità"]),
    currentRal: getField(record, ["Ral attuale", "RAL attuale"]),
    contract: getField(record, ["Inquadramento"]),
    desiredRal: getField(record, ["Ral Desiderata", "RAL Desiderata"]),
    source: getField(record, ["Fornitore CV"]),
    city: getField(record, ["Citta", "Città"]),
    geographicAvailability: getField(record, ["Disponibilità geografica", "DisponibilitÃ  geografica"]),
    firstInterviewAt: getField(record, ["Data Primo Colloquio"]),
    qmAt: getField(record, ["Data QM"]),
    relocationCity: getField(record, ["Città dove vuole trasferirsi", "CittÃ  dove vuole trasferirsi"]),
    email: getField(record, ["Email"]),
    notes: getField(record, ["Note BM"]),
    associatedNeed: getField(record, ["Need Associato"]),
    description: getField(record, ["Descrizione Candidato"]),
    files: [],
    raw: record
  };
}

function mapApplication(record, index) {
  return {
    id: `A-${index + 1}`,
    rowIndex: index,
    candidateId: record["Candidate Id"] || "",
    candidateName: record.Candidate || "",
    needId: record["Need Id"] || "",
    needTitle: record.Need || "",
    source: record["Fornitore CV"] || "",
    phase: record["Fase Processo"] || "",
    associatedAt: record["Data Associazione"] || "",
    notes: record.Note || "",
    raw: record
  };
}

function recordFromApplication(payload, current = {}) {
  return {
    ...current,
    "Candidate Id": payload.candidateId ?? current["Candidate Id"] ?? "",
    Candidate: payload.candidateName ?? payload.candidate ?? current.Candidate ?? "",
    "Need Id": payload.needId ?? current["Need Id"] ?? "",
    Need: payload.needTitle ?? payload.need ?? current.Need ?? "",
    "Fornitore CV": payload.source ?? current["Fornitore CV"] ?? "",
    "Fase Processo": payload.phase ?? current["Fase Processo"] ?? "",
    "Data Associazione": payload.associatedAt ?? current["Data Associazione"] ?? todayItalian(),
    Note: payload.notes ?? current.Note ?? ""
  };
}

function recordFromNeed(payload, current = {}) {
  const record = { ...current };
  setField(record, ["Title", "Titolo"], "Title", payload.title ?? getField(current, ["Title", "Titolo"]));
  setField(record, ["FTE ricercate"], "FTE ricercate", payload.fte ?? getField(current, ["FTE ricercate"]));
  setField(record, ["Cliente"], "Cliente", payload.client ?? getField(current, ["Cliente"]));
  setField(record, ["Sede"], "Sede", payload.location ?? getField(current, ["Sede"]));
  setField(record, ["Seniority"], "Seniority", payload.seniority ?? getField(current, ["Seniority"]));
  setField(record, ["Skills"], "Skills", Array.isArray(payload.skills) ? payload.skills.join(", ") : payload.skills ?? getField(current, ["Skills"]));
  setField(record, ["Urgenza"], "Urgenza", payload.urgency ?? getField(current, ["Urgenza"]));
  setField(record, ["Stato"], "Stato", payload.status ?? (getField(current, ["Stato"]) || "Open"));
  setField(record, ["Budget"], "Budget", payload.budget ?? getField(current, ["Budget"]));
  setField(record, ["Owner"], "Owner", payload.owner ?? getField(current, ["Owner"]));
  setField(record, ["Modalità lavoro", "ModalitÃ  lavoro"], "Modalità lavoro", payload.workMode ?? getField(current, ["Modalità lavoro", "ModalitÃ  lavoro"]));
  setField(record, ["Descrizione Job"], "Descrizione Job", payload.description ?? getField(current, ["Descrizione Job"]));
  setField(record, ["Data Apertura Need"], "Data Apertura Need", payload.openedAt ?? getField(current, ["Data Apertura Need"]));
  setField(record, ["Data Chiusura Need"], "Data Chiusura Need", payload.closedAt ?? getField(current, ["Data Chiusura Need"]));
  return record;
}

function recordFromCandidate(payload, current = {}) {
  const record = { ...current };
  setField(record, ["Title", "Nome e Cognome", "Nome", "Candidato"], "Title", payload.name ?? payload.title ?? getField(current, ["Title", "Nome e Cognome", "Nome", "Candidato"]));
  setField(record, ["Ruolo"], "Ruolo", payload.role ?? getField(current, ["Ruolo"]));
  setField(record, ["Skills"], "Skills", Array.isArray(payload.skills) ? payload.skills.join(", ") : payload.skills ?? getField(current, ["Skills"]));
  setField(record, ["Valutazione"], "Valutazione", payload.evaluation ?? getField(current, ["Valutazione"]));
  setField(record, ["Fase Processo"], "Fase Processo", payload.phase ?? getField(current, ["Fase Processo"]));
  setField(record, ["Annid di esperienza", "Anni di esperienza"], "Annid di esperienza", payload.experienceRaw ?? payload.experienceYears ?? getField(current, ["Annid di esperienza", "Anni di esperienza"]));
  setField(record, ["Disponibilita", "Disponibilità"], "Disponibilita", payload.availability ?? getField(current, ["Disponibilita", "Disponibilità"]));
  setField(record, ["Ral attuale", "RAL attuale"], "Ral attuale", payload.currentRal ?? getField(current, ["Ral attuale", "RAL attuale"]));
  setField(record, ["Inquadramento"], "Inquadramento", payload.contract ?? getField(current, ["Inquadramento"]));
  setField(record, ["Ral Desiderata", "RAL Desiderata"], "Ral Desiderata", payload.desiredRal ?? getField(current, ["Ral Desiderata", "RAL Desiderata"]));
  setField(record, ["Fornitore CV"], "Fornitore CV", payload.source ?? getField(current, ["Fornitore CV"]));
  setField(record, ["Citta", "Città"], "Citta", payload.city ?? getField(current, ["Citta", "Città"]));
  setField(record, ["Disponibilità geografica", "DisponibilitÃ  geografica"], "Disponibilità geografica", payload.geographicAvailability ?? getField(current, ["Disponibilità geografica", "DisponibilitÃ  geografica"]));
  setField(record, ["Data Primo Colloquio"], "Data Primo Colloquio", payload.firstInterviewAt ?? getField(current, ["Data Primo Colloquio"]));
  setField(record, ["Data QM"], "Data QM", payload.qmAt ?? getField(current, ["Data QM"]));
  setField(record, ["Città dove vuole trasferirsi", "CittÃ  dove vuole trasferirsi"], "Città dove vuole trasferirsi", payload.relocationCity ?? getField(current, ["Città dove vuole trasferirsi", "CittÃ  dove vuole trasferirsi"]));
  setField(record, ["Email"], "Email", payload.email ?? getField(current, ["Email"]));
  setField(record, ["Note BM"], "Note BM", payload.notes ?? getField(current, ["Note BM"]));
  setField(record, ["Need Associato"], "Need Associato", payload.associatedNeed ?? getField(current, ["Need Associato"]));
  setField(record, ["Descrizione Candidato"], "Descrizione Candidato", payload.description ?? getField(current, ["Descrizione Candidato"]));
  return record;
}

function todayItalian() {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, "0")}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}`;
}

function statusIsOpen(status) {
  const value = normalizeToken(status);
  return !value.includes("closed") && !value.includes("chiusa") && !value.includes("ko") && !value.includes("sospesa");
}

function statusIsClosedWin(status) {
  const value = normalizeToken(status);
  return value.includes("closed") && value.includes("win");
}

function statusIsClosedKo(status) {
  const value = normalizeToken(status);
  return value.includes("closed") && value.includes("ko");
}

function phasePenalty(phase) {
  const p = normalizeToken(phase);
  if (p.includes("ko")) return -35;
  if (p.includes("interno")) return 10;
  if (p.includes("qm ok")) return 9;
  if (p.includes("inviato dossier")) return 6;
  if (p.includes("organizzata qm")) return 7;
  if (p.includes("colloquio hr")) return 4;
  if (p.includes("primo contatto")) return 2;
  if (p.includes("primo colloquio")) return 3;
  return 0;
}

function evaluationScore(value) {
  const v = normalizeToken(value);
  if (v === "a" || v === "a+") return 6;
  if (v === "b+" || v === "b") return 4;
  if (v === "c") return 0;
  return 0;
}

function isCandidateVisibleInMatching(candidate) {
  const evaluation = normalizeToken(candidate.evaluation);
  const phase = normalizeToken(candidate.phase);
  const hiddenPhases = new Set(["ko bm", "ko cliente", "ko candidato"]);
  return evaluation !== "c" && !hiddenPhases.has(phase);
}

function scoreCandidateForNeed(candidate, need) {
  let score = 0;
  const positives = [];
  const warnings = [];
  const missing = [];

  const needSkillTokens = need.skills.map(normalizeToken).filter(Boolean);
  const candidateSkillTokens = candidate.skills.map(normalizeToken).filter(Boolean);
  const candidateText = normalizeToken(`${candidate.role} ${candidate.description} ${candidate.notes} ${candidate.skills.join(" ")}`);
  const matchedSkills = [];
  let skillPoints = 0;

  for (let i = 0; i < needSkillTokens.length; i += 1) {
    const needed = needSkillTokens[i];
    const matchType = skillMatchesCandidate(needed, candidateSkillTokens, candidateText);
    if (matchType) {
      matchedSkills.push(need.skills[i]);
      skillPoints += matchType === "direct" ? 1 : matchType === "text" ? 0.8 : 0.55;
    }
  }

  if (needSkillTokens.length) {
    const skillScore = Math.round((skillPoints / needSkillTokens.length) * 50);
    score += skillScore;
    if (matchedSkills.length) positives.push(`Skill coerenti: ${matchedSkills.join(", ")}`);
    else warnings.push("Nessuna skill esplicita in comune");
  } else {
    missing.push("Skill need");
  }

  const roleWords = new Set(words(`${candidate.role} ${candidate.description} ${candidate.notes}`));
  const titleWords = words(`${need.title} ${need.description}`);
  const roleHits = titleWords.filter((word) => roleWords.has(word));
  if (roleHits.length) {
    score += Math.min(18, roleHits.length * 4);
    positives.push("Ruolo affine al titolo del need");
  } else {
    warnings.push("Ruolo non chiaramente affine al need");
  }

  if (candidate.experienceYears != null) {
    const seniority = normalizeToken(need.seniority);
    const seniorityFits =
      (seniority.includes("neo") && candidate.experienceYears <= 2) ||
      ((seniority.includes("junior") || seniority.includes("jnr")) && candidate.experienceYears <= 5) ||
      ((seniority.includes("middle") || seniority.includes("mid")) && candidate.experienceYears >= 2 && candidate.experienceYears <= 9) ||
      (seniority.includes("senior") && candidate.experienceYears >= 5);
    if (seniorityFits) {
      score += 9;
      positives.push("Seniority coerente");
    } else {
      score += 3;
      warnings.push("Seniority da verificare");
    }
  } else {
    const seniorityText = normalizeToken(`${candidate.role} ${candidate.description}`);
    const needSeniority = normalizeToken(need.seniority);
    const seniorityTextFits =
      (needSeniority.includes("neo") && seniorityText.includes("neo")) ||
      ((needSeniority.includes("junior") || needSeniority.includes("jnr")) && (seniorityText.includes("junior") || seniorityText.includes("jnr"))) ||
      ((needSeniority.includes("middle") || needSeniority.includes("mid")) && (seniorityText.includes("middle") || seniorityText.includes("mid"))) ||
      (needSeniority.includes("senior") && seniorityText.includes("senior"));
    if (seniorityTextFits) {
      score += 6;
      positives.push("Seniority coerente dal profilo");
    } else {
      missing.push("anni esperienza");
    }
  }

  const needLocation = normalizeToken(need.location);
  const candidateCity = normalizeToken(candidate.city);
  const relocationCity = normalizeToken(candidate.relocationCity);
  const geo = normalizeToken(candidate.geographicAvailability);
  const workMode = normalizeToken(need.workMode);
  if (candidateCity && needLocation && (candidateCity === needLocation || needLocation.includes(candidateCity) || candidateCity.includes(needLocation))) {
    score += 8;
    positives.push("Sede compatibile");
  } else if (relocationCity && needLocation && (relocationCity === needLocation || needLocation.includes(relocationCity) || relocationCity.includes(needLocation))) {
    score += 8;
    positives.push(`Trasferimento compatibile con la sede: ${candidate.relocationCity}`);
  } else if (relocationCity) {
    score += 4;
    positives.push(`Disponibilità al trasferimento indicata: ${candidate.relocationCity}`);
  } else if (workMode.includes("remot") || geo.includes("si")) {
    score += 4;
    positives.push("Compatibilità geografica possibile");
  } else if (!candidateCity) {
    missing.push("città candidato");
  }

  const budgetMax = parseBudgetMax(need.budget);
  const desiredRal = parseBudgetMax(candidate.desiredRal);
  if (budgetMax && desiredRal) {
    if (desiredRal <= budgetMax) {
      score += 6;
      positives.push("RAL desiderata nel budget");
    } else {
      warnings.push("RAL desiderata sopra budget");
      score -= 6;
    }
  } else {
    missing.push("budget/RAL interpretabili");
  }

  const availability = normalizeToken(candidate.availability);
  if (availability.includes("subito") || availability.includes("immediat")) {
    score += 5;
    positives.push("Disponibilità immediata");
  } else if (availability.includes("preavviso")) {
    score += 2;
  } else if (!availability) {
    missing.push("disponibilità");
  }

  score += phasePenalty(candidate.phase);
  score += evaluationScore(candidate.evaluation);

  if (normalizeToken(candidate.associatedNeed) === normalizeToken(need.title)) {
    score += 8;
    positives.push("Già associato a questo need");
  } else if (candidate.associatedNeed) {
    warnings.push(`Già associato a: ${candidate.associatedNeed}`);
    score -= 6;
  }

  if (normalizeToken(candidate.phase).includes("ko")) warnings.push("Candidato in fase KO");

  const hasTechnicalMatch = matchedSkills.length > 0 || skillPoints >= 0.55;
  const hasRoleMatch = roleHits.length > 0;
  if (!hasTechnicalMatch && !hasRoleMatch) {
    score = Math.min(score, 35);
    warnings.push("Score limitato: mancano sia skill chiave sia ruolo affine");
  } else if (!hasTechnicalMatch) {
    score = Math.min(score, 65);
    warnings.push("Score limitato: mancano skill chiave riconoscibili");
  }

  return {
    candidate,
    score: Math.max(0, Math.min(100, Math.round(score))),
    matchedSkills,
    positives,
    warnings,
    missing
  };
}

function dbNeedRow(row) {
  return {
    id: row.id,
    rowIndex: null,
    title: row.title || "",
    fte: row.fte || "",
    client: row.client || "",
    location: row.location || "",
    seniority: row.seniority || "",
    skills: splitList(row.skills || ""),
    urgency: row.urgency || "",
    status: row.status || "",
    budget: row.budget || "",
    owner: row.owner || "",
    workMode: row.work_mode || "",
    description: row.description || "",
    openedAt: row.opened_at || "",
    closedAt: row.closed_at || "",
    raw: row
  };
}

function dbCandidateRow(row) {
  return {
    id: row.id,
    rowIndex: null,
    name: row.name || "",
    role: row.role || "",
    skills: splitList(row.skills || ""),
    evaluation: row.evaluation || "",
    phase: row.phase || "",
    experienceYears: parseNumber(row.experience_raw),
    experienceRaw: row.experience_raw || "",
    availability: row.availability || "",
    currentRal: row.current_ral || "",
    contract: row.contract || "",
    desiredRal: row.desired_ral || "",
    source: row.source || "",
    city: row.city || "",
    geographicAvailability: row.geographic_availability || "",
    firstInterviewAt: row.first_interview_at || "",
    qmAt: row.qm_at || "",
    relocationCity: row.relocation_city || "",
    email: row.email || "",
    notes: row.notes || "",
    associatedNeed: row.associated_need || "",
    description: row.description || "",
    files: row.files || [],
    raw: row
  };
}

function dbApplicationRow(row) {
  return {
    id: row.id,
    rowIndex: null,
    candidateId: row.candidate_id || "",
    candidateName: row.candidate_name || "",
    needId: row.need_id || "",
    needTitle: row.need_title || "",
    source: row.source || "",
    phase: row.phase || "",
    associatedAt: row.associated_at || "",
    notes: row.notes || "",
    raw: row
  };
}

async function dbListNeeds() {
  await ensurePostgresSchema();
  const result = await pgQuery("SELECT *, array_to_string(skills, ', ') AS skills FROM needs ORDER BY created_at, title");
  return result.rows.map(dbNeedRow);
}

async function dbListCandidates() {
  await ensurePostgresSchema();
  const result = await pgQuery("SELECT *, array_to_string(skills, ', ') AS skills FROM candidates ORDER BY created_at, name");
  const filesResult = await pgQuery("SELECT * FROM candidate_files ORDER BY created_at, original_name");
  const filesByCandidate = new Map();
  for (const file of filesResult.rows.map(candidateFileRow)) {
    if (!filesByCandidate.has(file.candidateId)) filesByCandidate.set(file.candidateId, []);
    filesByCandidate.get(file.candidateId).push(file);
  }
  return result.rows.map((row) => dbCandidateRow({ ...row, files: filesByCandidate.get(row.id) || [] }));
}

async function dbListApplications() {
  await ensurePostgresSchema();
  const result = await pgQuery(`
    SELECT a.*, c.name AS candidate_name, n.title AS need_title
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    JOIN needs n ON n.id = a.need_id
    ORDER BY a.created_at, c.name
  `);
  return result.rows.map(dbApplicationRow);
}

async function dbCreateNeed(payload) {
  await ensurePostgresSchema();
  const needs = await dbListNeeds();
  const record = recordFromNeed(payload);
  const item = mapNeed(record, needs.length);
  const id = makeId("N", needs.length, item.title);
  await pgQuery(`
    INSERT INTO needs (
      id, title, fte, client, location, seniority, skills, urgency, status, budget,
      owner, work_mode, description, opened_at, closed_at
    ) VALUES (
      ${sqlValue(id)}, ${sqlValue(item.title)}, ${sqlValue(item.fte)}, ${sqlValue(item.client)},
      ${sqlValue(item.location)}, ${sqlValue(item.seniority)}, ${sqlTextArray(item.skills)},
      ${sqlValue(item.urgency)}, ${sqlValue(item.status)}, ${sqlValue(item.budget)},
      ${sqlValue(item.owner)}, ${sqlValue(item.workMode)}, ${sqlValue(item.description)},
      ${sqlValue(item.openedAt)}, ${sqlValue(item.closedAt)}
    )
  `);
  return { item: { ...item, id } };
}

async function dbUpdateNeed(id, payload) {
  await ensurePostgresSchema();
  const current = (await dbListNeeds()).find((need) => need.id === id);
  if (!current) return null;
  const item = { ...current, ...payload, skills: Array.isArray(payload.skills) ? payload.skills : current.skills };
  await pgQuery(`
    UPDATE needs SET
      title = ${sqlValue(item.title)},
      fte = ${sqlValue(item.fte)},
      client = ${sqlValue(item.client)},
      location = ${sqlValue(item.location)},
      seniority = ${sqlValue(item.seniority)},
      skills = ${sqlTextArray(item.skills)},
      urgency = ${sqlValue(item.urgency)},
      status = ${sqlValue(item.status)},
      budget = ${sqlValue(item.budget)},
      owner = ${sqlValue(item.owner)},
      work_mode = ${sqlValue(item.workMode)},
      description = ${sqlValue(item.description)},
      opened_at = ${sqlValue(item.openedAt)},
      closed_at = ${sqlValue(item.closedAt)},
      updated_at = NOW()
    WHERE id = ${sqlValue(id)}
  `);
  return { item: { ...item, id } };
}

async function dbCreateCandidate(payload) {
  await ensurePostgresSchema();
  const candidates = await dbListCandidates();
  const record = recordFromCandidate(payload);
  const item = mapCandidate(record, candidates.length);
  const id = makeId("C", candidates.length, item.name);
  await pgQuery(`
    INSERT INTO candidates (
      id, name, role, skills, evaluation, phase, experience_raw, availability,
      current_ral, contract, desired_ral, source, city, geographic_availability,
      first_interview_at, qm_at, relocation_city, email, notes, associated_need, description
    ) VALUES (
      ${sqlValue(id)}, ${sqlValue(item.name)}, ${sqlValue(item.role)}, ${sqlTextArray(item.skills)},
      ${sqlValue(item.evaluation)}, ${sqlValue(item.phase)}, ${sqlValue(item.experienceRaw)},
      ${sqlValue(item.availability)}, ${sqlValue(item.currentRal)}, ${sqlValue(item.contract)},
      ${sqlValue(item.desiredRal)}, ${sqlValue(item.source)}, ${sqlValue(item.city)},
      ${sqlValue(item.geographicAvailability)}, ${sqlValue(item.firstInterviewAt)}, ${sqlValue(item.qmAt)},
      ${sqlValue(item.relocationCity)}, ${sqlValue(item.email)}, ${sqlValue(item.notes)},
      ${sqlValue(item.associatedNeed)}, ${sqlValue(item.description)}
    )
  `);
  return { item: { ...item, id } };
}

async function dbUpdateCandidate(id, payload) {
  await ensurePostgresSchema();
  const current = (await dbListCandidates()).find((candidate) => candidate.id === id);
  if (!current) return null;
  const item = { ...current, ...payload, skills: Array.isArray(payload.skills) ? payload.skills : current.skills };
  await pgQuery(`
    UPDATE candidates SET
      name = ${sqlValue(item.name)},
      role = ${sqlValue(item.role)},
      skills = ${sqlTextArray(item.skills)},
      evaluation = ${sqlValue(item.evaluation)},
      phase = ${sqlValue(item.phase)},
      experience_raw = ${sqlValue(item.experienceRaw)},
      availability = ${sqlValue(item.availability)},
      current_ral = ${sqlValue(item.currentRal)},
      contract = ${sqlValue(item.contract)},
      desired_ral = ${sqlValue(item.desiredRal)},
      source = ${sqlValue(item.source)},
      city = ${sqlValue(item.city)},
      geographic_availability = ${sqlValue(item.geographicAvailability)},
      first_interview_at = ${sqlValue(item.firstInterviewAt)},
      qm_at = ${sqlValue(item.qmAt)},
      relocation_city = ${sqlValue(item.relocationCity)},
      email = ${sqlValue(item.email)},
      notes = ${sqlValue(item.notes)},
      associated_need = ${sqlValue(item.associatedNeed)},
      description = ${sqlValue(item.description)},
      updated_at = NOW()
    WHERE id = ${sqlValue(id)}
  `);
  await pgQuery(`
    UPDATE applications
    SET source = ${sqlValue(item.source)}, phase = ${sqlValue(item.phase)}, updated_at = NOW()
    WHERE candidate_id = ${sqlValue(id)}
  `);
  return { item: { ...item, id } };
}

async function dbDeleteCandidate(id) {
  await ensurePostgresSchema();
  const current = (await dbListCandidates()).find((candidate) => candidate.id === id);
  if (!current) return null;
  await pgQuery(`DELETE FROM candidates WHERE id = ${sqlValue(id)}`);
  await fs.rm(path.join(uploadsRoot(), "candidates", safeFilename(id)), { recursive: true, force: true }).catch(() => {});
  return { item: current };
}

async function dbAddCandidateFiles(candidateId, files) {
  await ensurePostgresSchema();
  const current = (await dbListCandidates()).find((candidate) => candidate.id === candidateId);
  if (!current) {
    const error = new Error("Candidato non trovato");
    error.status = 404;
    throw error;
  }

  const relativeDir = path.join("candidates", safeFilename(candidateId));
  const candidateDir = path.join(uploadsRoot(), relativeDir);
  await fs.mkdir(candidateDir, { recursive: true });
  const saved = [];

  for (const file of files) {
    if (!file.data?.length) continue;
    const id = `F-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const originalName = safeFilename(file.filename);
    const storedName = `${id}-${originalName}`;
    const filePath = path.join(candidateDir, storedName);
    const relativePath = path.join(relativeDir, storedName).replace(/\\/g, "/");
    await fs.writeFile(filePath, file.data);
    await pgQuery(`
      INSERT INTO candidate_files (id, candidate_id, original_name, stored_name, mime_type, size_bytes, file_path)
      VALUES (
        ${sqlValue(id)}, ${sqlValue(candidateId)}, ${sqlValue(file.filename)}, ${sqlValue(storedName)},
        ${sqlValue(file.mimeType)}, ${sqlValue(String(file.data.length))}, ${sqlValue(relativePath)}
      )
    `);
    saved.push({ id, candidateId, name: file.filename, mimeType: file.mimeType, size: file.data.length, downloadUrl: `/api/candidate-files/${encodeURIComponent(id)}/download` });
  }

  return { files: saved, imported: saved.length };
}

async function dbCandidateFile(id) {
  await ensurePostgresSchema();
  const result = await pgQuery(`SELECT * FROM candidate_files WHERE id = ${sqlValue(id)}`);
  if (!result.rows.length) return null;
  return { ...candidateFileRow(result.rows[0]), filePath: result.rows[0].file_path };
}

async function dbDeleteCandidateFile(id) {
  const file = await dbCandidateFile(id);
  if (!file) return null;
  await pgQuery(`DELETE FROM candidate_files WHERE id = ${sqlValue(id)}`);
  await fs.rm(resolveUploadPath(file.filePath), { force: true }).catch(() => {});
  return { item: file };
}

async function importCsvToPostgres({ truncate = false } = {}) {
  await ensurePostgresSchema();
  if (truncate) {
    await pgQuery("TRUNCATE applications, candidates, needs RESTART IDENTITY");
  }

  const needs = (await readCsv("needs")).records.map(mapNeed);
  const candidates = (await readCsv("candidates")).records.map(mapCandidate);
  const applications = (await readCsv("applications")).records.map(mapApplication);

  for (const need of needs) {
    await pgQuery(`
      INSERT INTO needs (
        id, title, fte, client, location, seniority, skills, urgency, status, budget,
        owner, work_mode, description, opened_at, closed_at
      ) VALUES (
        ${sqlValue(need.id)}, ${sqlValue(need.title)}, ${sqlValue(need.fte)}, ${sqlValue(need.client)},
        ${sqlValue(need.location)}, ${sqlValue(need.seniority)}, ${sqlTextArray(need.skills)},
        ${sqlValue(need.urgency)}, ${sqlValue(need.status)}, ${sqlValue(need.budget)},
        ${sqlValue(need.owner)}, ${sqlValue(need.workMode)}, ${sqlValue(need.description)},
        ${sqlValue(need.openedAt)}, ${sqlValue(need.closedAt)}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title, fte = EXCLUDED.fte, client = EXCLUDED.client,
        location = EXCLUDED.location, seniority = EXCLUDED.seniority, skills = EXCLUDED.skills,
        urgency = EXCLUDED.urgency, status = EXCLUDED.status, budget = EXCLUDED.budget,
        owner = EXCLUDED.owner, work_mode = EXCLUDED.work_mode, description = EXCLUDED.description,
        opened_at = EXCLUDED.opened_at, closed_at = EXCLUDED.closed_at, updated_at = NOW()
    `);
  }

  for (const candidate of candidates) {
    await pgQuery(`
      INSERT INTO candidates (
        id, name, role, skills, evaluation, phase, experience_raw, availability,
        current_ral, contract, desired_ral, source, city, geographic_availability,
        first_interview_at, qm_at, relocation_city, email, notes, associated_need, description
      ) VALUES (
        ${sqlValue(candidate.id)}, ${sqlValue(candidate.name)}, ${sqlValue(candidate.role)}, ${sqlTextArray(candidate.skills)},
        ${sqlValue(candidate.evaluation)}, ${sqlValue(candidate.phase)}, ${sqlValue(candidate.experienceRaw)},
        ${sqlValue(candidate.availability)}, ${sqlValue(candidate.currentRal)}, ${sqlValue(candidate.contract)},
        ${sqlValue(candidate.desiredRal)}, ${sqlValue(candidate.source)}, ${sqlValue(candidate.city)},
        ${sqlValue(candidate.geographicAvailability)}, ${sqlValue(candidate.firstInterviewAt)}, ${sqlValue(candidate.qmAt)},
        ${sqlValue(candidate.relocationCity)}, ${sqlValue(candidate.email)}, ${sqlValue(candidate.notes)},
        ${sqlValue(candidate.associatedNeed)}, ${sqlValue(candidate.description)}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, role = EXCLUDED.role, skills = EXCLUDED.skills,
        evaluation = EXCLUDED.evaluation, phase = EXCLUDED.phase, experience_raw = EXCLUDED.experience_raw,
        availability = EXCLUDED.availability, current_ral = EXCLUDED.current_ral, contract = EXCLUDED.contract,
        desired_ral = EXCLUDED.desired_ral, source = EXCLUDED.source, city = EXCLUDED.city,
        geographic_availability = EXCLUDED.geographic_availability, first_interview_at = EXCLUDED.first_interview_at,
        qm_at = EXCLUDED.qm_at, relocation_city = EXCLUDED.relocation_city, email = EXCLUDED.email,
        notes = EXCLUDED.notes, associated_need = EXCLUDED.associated_need,
        description = EXCLUDED.description, updated_at = NOW()
    `);
  }

  for (const app of applications) {
    if (!app.candidateId || !app.needId) continue;
    await pgQuery(`
      INSERT INTO applications (id, candidate_id, need_id, source, phase, associated_at, notes)
      VALUES (
        ${sqlValue(app.id)}, ${sqlValue(app.candidateId)}, ${sqlValue(app.needId)},
        ${sqlValue(app.source)}, ${sqlValue(app.phase)}, ${sqlValue(app.associatedAt)}, ${sqlValue(app.notes)}
      )
      ON CONFLICT (candidate_id, need_id) DO UPDATE SET
        source = EXCLUDED.source, phase = EXCLUDED.phase, associated_at = EXCLUDED.associated_at,
        notes = EXCLUDED.notes, updated_at = NOW()
    `);
  }

  return { needs: needs.length, candidates: candidates.length, applications: applications.length };
}

async function listNeeds() {
  if (usePostgres()) return dbListNeeds();
  const { records } = await readCsv("needs");
  return records.map(mapNeed);
}

async function listCandidates() {
  if (usePostgres()) return dbListCandidates();
  const { records } = await readCsv("candidates");
  return records.map(mapCandidate);
}

async function listApplications() {
  if (usePostgres()) return dbListApplications();
  const data = await readCsv("applications");
  if (data.records.length === 0) {
    const [needs, candidates] = await Promise.all([listNeeds(), listCandidates()]);
    const seeded = candidates
      .filter((candidate) => candidate.associatedNeed)
      .map((candidate) => {
        const need = needs.find((item) => normalizeToken(item.title) === normalizeToken(candidate.associatedNeed));
        return recordFromApplication({
          candidateId: candidate.id,
          candidateName: candidate.name,
          needId: need?.id || "",
          needTitle: candidate.associatedNeed,
          source: candidate.source,
          phase: candidate.phase,
          associatedAt: todayItalian(),
          notes: "Importato da Need Associato"
        });
      });
    if (seeded.length) {
      await writeCsv("applications", APPLICATION_COLUMNS, seeded);
      return seeded.map(mapApplication);
    }
  }
  return data.records.map(mapApplication);
}

async function createApplication(payload) {
  if (usePostgres()) {
    await ensurePostgresSchema();
    const [needs, candidates, applications] = await Promise.all([dbListNeeds(), dbListCandidates(), dbListApplications()]);
    const candidate = candidates.find((item) => item.id === payload.candidateId || item.name === payload.candidateName);
    const need = needs.find((item) => item.id === payload.needId || item.title === payload.needTitle);
    if (!candidate || !need) {
      const error = new Error(`Impossibile creare associazione: ${!candidate ? "candidato" : "need"} non trovato`);
      error.status = 404;
      throw error;
    }
    if (applications.some((item) => item.candidateId === candidate.id && item.needId === need.id)) {
      const error = new Error("Associazione gia presente");
      error.status = 409;
      throw error;
    }
    const id = `A-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    await pgQuery(`
      INSERT INTO applications (id, candidate_id, need_id, source, phase, associated_at, notes)
      VALUES (
        ${sqlValue(id)}, ${sqlValue(candidate.id)}, ${sqlValue(need.id)},
        ${sqlValue(candidate.source)}, ${sqlValue(candidate.phase)},
        ${sqlValue(todayItalian())}, ${sqlValue(payload.notes || "")}
      )
    `);
    return { item: { id, candidateId: candidate.id, candidateName: candidate.name, needId: need.id, needTitle: need.title, source: candidate.source, phase: candidate.phase, associatedAt: todayItalian(), notes: payload.notes || "" } };
  }

  const [appsData, needs, candidates] = await Promise.all([
    readCsv("applications"),
    listNeeds(),
    listCandidates()
  ]);
  const candidate = candidates.find((item) => item.id === payload.candidateId || item.name === payload.candidateName);
  const need = needs.find((item) => item.id === payload.needId || item.title === payload.needTitle);
  if (!candidate || !need) {
    const missing = !candidate ? "candidato" : "need";
    const error = new Error(`Impossibile creare associazione: ${missing} non trovato`);
    error.status = 404;
    throw error;
  }

  const alreadyExists = appsData.records.some((record) =>
    normalizeToken(record.Candidate) === normalizeToken(candidate.name) &&
    normalizeToken(record.Need) === normalizeToken(need.title)
  );
  if (alreadyExists) {
    const error = new Error("Associazione già presente");
    error.status = 409;
    throw error;
  }

  const record = recordFromApplication({
    candidateId: candidate.id,
    candidateName: candidate.name,
    needId: need.id,
    needTitle: need.title,
    source: candidate.source,
    phase: candidate.phase,
    associatedAt: todayItalian(),
    notes: payload.notes || ""
  });
  const headers = [...new Set([...appsData.headers, ...APPLICATION_COLUMNS])];
  appsData.records.push(record);
  const write = await writeCsv("applications", headers, appsData.records);
  return { item: mapApplication(record, appsData.records.length - 1), ...write };
}

async function syncApplicationsForCandidate(previousName, candidate) {
  const data = await readCsv("applications");
  const previousKey = normalizeToken(previousName);
  const currentKey = normalizeToken(candidate.name);
  let changed = false;

  const records = data.records.map((record) => {
    const matchesCandidate =
      record["Candidate Id"] === candidate.id ||
      normalizeToken(record.Candidate) === previousKey ||
      normalizeToken(record.Candidate) === currentKey;

    if (!matchesCandidate) return record;

    changed = true;
    return {
      ...record,
      "Candidate Id": candidate.id,
      Candidate: candidate.name,
      "Fornitore CV": candidate.source,
      "Fase Processo": candidate.phase
    };
  });

  if (changed) {
    const headers = [...new Set([...data.headers, ...APPLICATION_COLUMNS])];
    await writeCsv("applications", headers, records);
  }
}

async function dashboard() {
  const [needs, candidates, applications] = await Promise.all([listNeeds(), listCandidates(), listApplications()]);
  const byPhase = {};
  for (const candidate of candidates) {
    const phase = candidate.phase || "Senza fase";
    byPhase[phase] = (byPhase[phase] || 0) + 1;
  }

  const candidatesBySource = {};
  const candidateStatusBySource = {};
  for (const candidate of candidates) {
    const source = candidate.source || "Non indicato";
    const phase = candidate.phase || "Senza fase";
    candidatesBySource[source] = (candidatesBySource[source] || 0) + 1;
    if (!candidateStatusBySource[source]) candidateStatusBySource[source] = {};
    candidateStatusBySource[source][phase] = (candidateStatusBySource[source][phase] || 0) + 1;
  }

  const proposalsByNeedAndSource = {};
  const candidateByName = new Map(candidates.map((candidate) => [normalizeToken(candidate.name), candidate]));
  const candidateStatusByNeed = {};
  for (const application of applications) {
    const need = application.needTitle || "Need non indicato";
    const candidate = candidateByName.get(normalizeToken(application.candidateName));
    const source = candidate?.source || application.source || "Non indicato";
    if (!proposalsByNeedAndSource[need]) proposalsByNeedAndSource[need] = {};
    proposalsByNeedAndSource[need][source] = (proposalsByNeedAndSource[need][source] || 0) + 1;

    const phase = candidate?.phase || application.phase || "Senza fase";
    if (!candidateStatusByNeed[need]) candidateStatusByNeed[need] = {};
    candidateStatusByNeed[need][phase] = (candidateStatusByNeed[need][phase] || 0) + 1;
  }

  return {
    openNeeds: needs.filter((need) => statusIsOpen(need.status)).length,
    urgentNeeds: needs.filter((need) => statusIsOpen(need.status) && normalizeToken(need.urgency) === "alta").length,
    closedWinNeeds: needs.filter((need) => statusIsClosedWin(need.status)).length,
    closedKoNeeds: needs.filter((need) => statusIsClosedKo(need.status)).length,
    totalNeeds: needs.length,
    totalCandidates: candidates.length,
    totalApplications: applications.length,
    associatedCandidates: new Set(applications.map((application) => normalizeToken(application.candidateName)).filter(Boolean)).size,
    byPhase,
    candidatesBySource,
    candidateStatusBySource,
    candidateStatusByNeed,
    proposalsByNeedAndSource
  };
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function worksheetXml(headers, rows) {
  const allRows = [headers, ...rows];
  const rowXml = allRows.map((row, rowIndex) => {
    const cells = row.map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const lastRef = `${columnName(headers.length - 1)}${Math.max(1, allRows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastRef}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFile(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

function xlsxBuffer(sheetName, headers, rows) {
  const safeSheetName = sheetName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Export";
  return zipFile([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlEscape(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: worksheetXml(headers, rows)
    }
  ]);
}

async function exportCandidatesXlsx() {
  const headers = ["Nome", "Ruolo", "Skills", "Valutazione", "Fase Processo", "Anni esperienza", "Disponibilita", "RAL attuale", "Inquadramento", "RAL desiderata", "Fornitore CV", "Citta", "Disponibilita geografica", "Data Primo Colloquio", "Data QM", "Citta trasferimento", "Email", "Note BM", "Need Associati", "Descrizione"];
  const rows = (await listCandidates()).map((candidate) => [
    candidate.name,
    candidate.role,
    candidate.skills.join(", "),
    candidate.evaluation,
    candidate.phase,
    candidate.experienceRaw,
    candidate.availability,
    candidate.currentRal,
    candidate.contract,
    candidate.desiredRal,
    candidate.source,
    candidate.city,
    candidate.geographicAvailability,
    candidate.firstInterviewAt,
    candidate.qmAt,
    candidate.relocationCity,
    candidate.email,
    candidate.notes,
    candidate.associatedNeed,
    candidate.description
  ]);
  return xlsxBuffer("Candidati", headers, rows);
}

async function exportNeedsXlsx() {
  const headers = ["Titolo", "FTE ricercate", "Cliente", "Sede", "Seniority", "Skills", "Urgenza", "Stato", "Budget", "Owner", "Modalita lavoro", "Descrizione Job", "Data Apertura Need", "Data Chiusura Need"];
  const rows = (await listNeeds()).map((need) => [
    need.title,
    need.fte,
    need.client,
    need.location,
    need.seniority,
    need.skills.join(", "),
    need.urgency,
    need.status,
    need.budget,
    need.owner,
    need.workMode,
    need.description,
    need.openedAt,
    need.closedAt
  ]);
  return xlsxBuffer("Need", headers, rows);
}

function needPayloadFromRecord(record, index) {
  const need = mapNeed(record, index);
  return {
    title: need.title,
    fte: need.fte,
    client: need.client,
    location: need.location,
    seniority: need.seniority,
    skills: need.skills,
    urgency: need.urgency,
    status: need.status || "Open",
    budget: need.budget,
    owner: need.owner,
    workMode: need.workMode,
    description: need.description,
    openedAt: need.openedAt,
    closedAt: need.closedAt
  };
}

function candidatePayloadFromRecord(record, index) {
  const candidate = mapCandidate(record, index);
  return {
    name: candidate.name,
    role: candidate.role,
    skills: candidate.skills,
    evaluation: candidate.evaluation,
    phase: candidate.phase || "Primo contatto",
    experienceRaw: candidate.experienceRaw,
    availability: candidate.availability,
    currentRal: candidate.currentRal,
    contract: candidate.contract,
    desiredRal: candidate.desiredRal,
    source: candidate.source,
    city: candidate.city,
    geographicAvailability: candidate.geographicAvailability,
    firstInterviewAt: candidate.firstInterviewAt,
    qmAt: candidate.qmAt,
    relocationCity: candidate.relocationCity,
    email: candidate.email,
    notes: candidate.notes,
    associatedNeed: candidate.associatedNeed,
    description: candidate.description
  };
}

async function importNeeds(records) {
  const existing = await listNeeds();
  const existingTitles = new Set(existing.map((need) => normalizeToken(need.title)).filter(Boolean));
  let imported = 0;
  let skipped = 0;

  if (usePostgres()) {
    for (const [index, record] of records.entries()) {
      const payload = needPayloadFromRecord(record, index);
      const key = normalizeToken(payload.title);
      if (!key || existingTitles.has(key)) {
        skipped += 1;
        continue;
      }
      await dbCreateNeed(payload);
      existingTitles.add(key);
      imported += 1;
    }
    return { imported, skipped, total: records.length };
  }

  const data = await readCsv("needs");
  const headers = [...new Set([...data.headers, ...NEED_COLUMNS])];
  for (const [index, record] of records.entries()) {
    const payload = needPayloadFromRecord(record, index);
    const key = normalizeToken(payload.title);
    if (!key || existingTitles.has(key)) {
      skipped += 1;
      continue;
    }
    data.records.push(recordFromNeed(payload));
    existingTitles.add(key);
    imported += 1;
  }
  if (imported) await writeCsv("needs", headers, data.records);
  return { imported, skipped, total: records.length };
}

async function importCandidates(records) {
  const existing = await listCandidates();
  const existingNames = new Set(existing.map((candidate) => normalizeToken(candidate.name)).filter(Boolean));
  const existingEmails = new Set(existing.map((candidate) => normalizeToken(candidate.email)).filter(Boolean));
  let imported = 0;
  let skipped = 0;

  const shouldSkip = (payload) => {
    const name = normalizeToken(payload.name);
    const email = normalizeToken(payload.email);
    return !name || existingNames.has(name) || (email && existingEmails.has(email));
  };

  const markImported = (payload) => {
    const name = normalizeToken(payload.name);
    const email = normalizeToken(payload.email);
    if (name) existingNames.add(name);
    if (email) existingEmails.add(email);
  };

  if (usePostgres()) {
    for (const [index, record] of records.entries()) {
      const payload = candidatePayloadFromRecord(record, index);
      if (shouldSkip(payload)) {
        skipped += 1;
        continue;
      }
      await dbCreateCandidate(payload);
      markImported(payload);
      imported += 1;
    }
    return { imported, skipped, total: records.length };
  }

  const data = await readCsv("candidates");
  const headers = [...new Set([...data.headers, ...CANDIDATE_COLUMNS])];
  for (const [index, record] of records.entries()) {
    const payload = candidatePayloadFromRecord(record, index);
    if (shouldSkip(payload)) {
      skipped += 1;
      continue;
    }
    data.records.push(recordFromCandidate(payload));
    markImported(payload);
    imported += 1;
  }
  if (imported) await writeCsv("candidates", headers, data.records);
  return { imported, skipped, total: records.length };
}

async function importFile(kind, file) {
  const records = parseImportFile(file);
  if (kind === "needs") return importNeeds(records);
  if (kind === "candidates") return importCandidates(records);
  const error = new Error("Tipo import non valido");
  error.status = 400;
  throw error;
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function requestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function multipartFile(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("File import non valido");
    error.status = 400;
    throw error;
  }

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const buffer = await requestBuffer(req);
  const body = buffer.toString("latin1");
  const headerStart = body.indexOf(boundary);
  const headerEnd = body.indexOf("\r\n\r\n", headerStart);
  const dataStart = headerEnd + 4;
  const dataEnd = body.indexOf(`\r\n${boundary}`, dataStart);
  if (headerStart === -1 || headerEnd === -1 || dataEnd === -1) {
    const error = new Error("File import non leggibile");
    error.status = 400;
    throw error;
  }

  const headers = body.slice(headerStart + boundary.length, headerEnd);
  const filename = headers.match(/filename="([^"]*)"/i)?.[1] || "import";
  return { filename, data: buffer.subarray(dataStart, dataEnd) };
}

function xmlUnescape(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function columnIndex(ref = "") {
  const letters = String(ref).match(/[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function zipEntries(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("File Excel non valido");

  const entries = {};
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Indice Excel non valido");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null;
    if (data) entries[name] = data;

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function parseSharedStrings(xml = "") {
  return [...xml.matchAll(/<si[\s\S]*?<\/si>/g)].map(([si]) =>
    [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => xmlUnescape(match[1])).join("")
  );
}

function parseSheetRows(xml, sharedStrings) {
  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(([, rowXml]) => {
    const cells = [];
    for (const match of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = match[1];
      const cellXml = match[2];
      const ref = attrs.match(/\sr="([^"]+)"/)?.[1] || "";
      const type = attrs.match(/\st="([^"]+)"/)?.[1] || "";
      const index = columnIndex(ref);
      let value = "";
      if (type === "s") {
        const sharedIndex = Number(cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || 0);
        value = sharedStrings[sharedIndex] || "";
      } else if (type === "inlineStr") {
        value = [...cellXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((item) => xmlUnescape(item[1])).join("");
      } else {
        value = xmlUnescape(cellXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "");
      }
      cells[index] = value;
    }
    return cells.map((value) => value || "");
  }).filter((row) => row.some(Boolean));
}

function recordsFromRows(rows) {
  const headers = rows[0] || [];
  return rows.slice(1).map((values) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = values[index] || "";
    });
    return record;
  }).filter((record) => Object.values(record).some(Boolean));
}

function parseXlsx(buffer) {
  const entries = zipEntries(buffer);
  const sharedStrings = parseSharedStrings(entries["xl/sharedStrings.xml"]?.toString("utf8") || "");
  const sheetName = Object.keys(entries).find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!sheetName) throw new Error("Nessun foglio trovato nel file Excel");
  return recordsFromRows(parseSheetRows(entries[sheetName].toString("utf8"), sharedStrings));
}

function parseImportFile(file) {
  const filename = file.filename.toLowerCase();
  if (filename.endsWith(".xlsx")) return parseXlsx(file.data);
  if (filename.endsWith(".csv")) return parseCsv(file.data.toString("utf8").replace(/^\uFEFF/, "")).records;
  const error = new Error("Formato non supportato. Usa file .xlsx o .csv");
  error.status = 400;
  throw error;
}

function parseMultipartFiles(req) {
  return multipartFiles(req);
}

async function multipartFiles(req) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    const error = new Error("Upload file non valido");
    error.status = 400;
    throw error;
  }

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const buffer = await requestBuffer(req);
  const body = buffer.toString("latin1");
  const files = [];
  let cursor = 0;

  while (true) {
    const partStart = body.indexOf(boundary, cursor);
    if (partStart === -1) break;
    const headerStart = partStart + boundary.length;
    if (body.slice(headerStart, headerStart + 2) === "--") break;
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    if (headerEnd === -1) break;
    const dataStart = headerEnd + 4;
    const dataEnd = body.indexOf(`\r\n${boundary}`, dataStart);
    if (dataEnd === -1) break;
    const headers = body.slice(headerStart, headerEnd);
    const filename = headers.match(/filename="([^"]*)"/i)?.[1] || "";
    const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    if (filename) {
      files.push({
        filename,
        mimeType: contentTypeMatch?.[1]?.trim() || "application/octet-stream",
        data: buffer.subarray(dataStart, dataEnd)
      });
    }
    cursor = dataEnd + 2;
  }

  return files;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": allowedOrigin(),
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details });
}

function sendXlsx(res, filename, buffer) {
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": allowedOrigin()
  });
  res.end(buffer);
}

async function sendDownload(res, file) {
  const resolved = resolveUploadPath(file.filePath);
  if (!allowedUploadRoots().some((root) => resolved.startsWith(root))) return sendError(res, 403, "Percorso file non valido");
  try {
    const stat = await fs.stat(resolved);
    res.writeHead(200, {
      "Content-Type": file.mimeType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safeFilename(file.name)}"`,
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": allowedOrigin()
    });
    createReadStream(resolved).pipe(res);
  } catch {
    sendError(res, 404, "File non trovato. Su Render verifica che UPLOADS_DIR punti a un Persistent Disk.");
  }
}

async function api(req, res, url) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  if (url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      backend: usePostgres() ? "postgres" : "csv",
      database: usePostgres() ? parseDatabaseUrl().database : undefined,
      uploadsDir: uploadsRoot(),
      csv: !usePostgres() && !isProduction()
        ? { needs: csvPath("needs"), candidates: csvPath("candidates"), applications: csvPath("applications") }
        : undefined
    });
  }

  if (req.method === "GET" && url.pathname === "/api/needs") return sendJson(res, 200, await listNeeds());
  if (req.method === "GET" && url.pathname === "/api/candidates") return sendJson(res, 200, await listCandidates());
  if (req.method === "GET" && url.pathname === "/api/applications") return sendJson(res, 200, await listApplications());
  if (req.method === "GET" && url.pathname === "/api/dashboard") return sendJson(res, 200, await dashboard());
  if (req.method === "GET" && url.pathname === "/api/export/candidates.xlsx") return sendXlsx(res, "candidati.xlsx", await exportCandidatesXlsx());
  if (req.method === "GET" && url.pathname === "/api/export/needs.xlsx") return sendXlsx(res, "need.xlsx", await exportNeedsXlsx());

  const fileDownloadRoute = url.pathname.match(/^\/api\/candidate-files\/([^/]+)\/download$/);
  if (req.method === "GET" && fileDownloadRoute) {
    const file = await dbCandidateFile(decodeURIComponent(fileDownloadRoute[1]));
    if (!file) return sendError(res, 404, "File non trovato");
    return sendDownload(res, file);
  }

  const fileRoute = url.pathname.match(/^\/api\/candidate-files\/([^/]+)$/);
  if (req.method === "DELETE" && fileRoute) {
    const result = await dbDeleteCandidateFile(decodeURIComponent(fileRoute[1]));
    if (!result) return sendError(res, 404, "File non trovato");
    return sendJson(res, 200, result);
  }

  const importRoute = url.pathname.match(/^\/api\/import\/(needs|candidates)$/);
  if (req.method === "POST" && importRoute) {
    try {
      const file = await multipartFile(req);
      return sendJson(res, 200, await importFile(importRoute[1], file));
    } catch (error) {
      return sendError(res, error.status || 500, error.message);
    }
  }

  const candidateFilesRoute = url.pathname.match(/^\/api\/candidates\/([^/]+)\/files$/);
  if (req.method === "POST" && candidateFilesRoute) {
    try {
      const files = await multipartFiles(req);
      return sendJson(res, 201, await dbAddCandidateFiles(decodeURIComponent(candidateFilesRoute[1]), files));
    } catch (error) {
      return sendError(res, error.status || 500, error.message);
    }
  }

  if (req.method === "POST" && url.pathname === "/api/applications") {
    try {
      const body = await jsonBody(req);
      return sendJson(res, 201, await createApplication(body));
    } catch (error) {
      return sendError(res, error.status || 500, error.message);
    }
  }

  const matchRoute = url.pathname.match(/^\/api\/needs\/([^/]+)\/matches$/);
  if (req.method === "GET" && matchRoute) {
    const id = decodeURIComponent(matchRoute[1]);
    const [needs, candidates] = await Promise.all([listNeeds(), listCandidates()]);
    const need = needs.find((item) => item.id === id);
    if (!need) return sendError(res, 404, "Need non trovato");
    const matches = candidates
      .filter(isCandidateVisibleInMatching)
      .map((candidate) => scoreCandidateForNeed(candidate, need))
      .sort((a, b) => b.score - a.score);
    return sendJson(res, 200, { need, matches });
  }

  if (req.method === "POST" && url.pathname === "/api/needs") {
    const body = await jsonBody(req);
    if (usePostgres()) {
      const result = await dbCreateNeed(body);
      result.emailNotification = await notifyNeedCreated(result.item);
      return sendJson(res, 201, result);
    }
    const data = await readCsv("needs");
    const headers = [...new Set([...data.headers, ...NEED_COLUMNS])];
    data.records.push(recordFromNeed(body));
    const write = await writeCsv("needs", headers, data.records);
    const item = mapNeed(data.records.at(-1), data.records.length - 1);
    const emailNotification = await notifyNeedCreated(item);
    return sendJson(res, 201, { item, emailNotification, ...write });
  }

  const needRoute = url.pathname.match(/^\/api\/needs\/([^/]+)$/);
  if (req.method === "PUT" && needRoute) {
    const body = await jsonBody(req);
    if (usePostgres()) {
      const result = await dbUpdateNeed(decodeURIComponent(needRoute[1]), body);
      if (!result) return sendError(res, 404, "Need non trovato");
      return sendJson(res, 200, result);
    }
    const data = await readCsv("needs");
    const index = indexFromId(decodeURIComponent(needRoute[1]));
    if (index < 0 || index >= data.records.length) return sendError(res, 404, "Need non trovato");
    data.records[index] = recordFromNeed(body, data.records[index]);
    const headers = [...new Set([...data.headers, ...NEED_COLUMNS])];
    const write = await writeCsv("needs", headers, data.records);
    return sendJson(res, 200, { item: mapNeed(data.records[index], index), ...write });
  }

  if (req.method === "POST" && url.pathname === "/api/candidates") {
    const body = await jsonBody(req);
    if (usePostgres()) {
      const result = await dbCreateCandidate(body);
      result.emailNotification = await notifyCandidateCreated(result.item);
      return sendJson(res, 201, result);
    }
    const data = await readCsv("candidates");
    const headers = [...new Set([...data.headers, ...CANDIDATE_COLUMNS])];
    data.records.push(recordFromCandidate(body));
    const write = await writeCsv("candidates", headers, data.records);
    const item = mapCandidate(data.records.at(-1), data.records.length - 1);
    const emailNotification = await notifyCandidateCreated(item);
    return sendJson(res, 201, { item, emailNotification, ...write });
  }

  const candidateRoute = url.pathname.match(/^\/api\/candidates\/([^/]+)$/);
  if (req.method === "PUT" && candidateRoute) {
    const body = await jsonBody(req);
    if (usePostgres()) {
      const result = await dbUpdateCandidate(decodeURIComponent(candidateRoute[1]), body);
      if (!result) return sendError(res, 404, "Candidato non trovato");
      return sendJson(res, 200, result);
    }
    const data = await readCsv("candidates");
    const index = indexFromId(decodeURIComponent(candidateRoute[1]));
    if (index < 0 || index >= data.records.length) return sendError(res, 404, "Candidato non trovato");
    const previousName = data.records[index].Title || "";
    data.records[index] = recordFromCandidate(body, data.records[index]);
    const headers = [...new Set([...data.headers, ...CANDIDATE_COLUMNS])];
    const write = await writeCsv("candidates", headers, data.records);
    const item = mapCandidate(data.records[index], index);
    await syncApplicationsForCandidate(previousName, item);
    return sendJson(res, 200, { item, ...write });
  }

  if (req.method === "DELETE" && candidateRoute) {
    if (usePostgres()) {
      const result = await dbDeleteCandidate(decodeURIComponent(candidateRoute[1]));
      if (!result) return sendError(res, 404, "Candidato non trovato");
      return sendJson(res, 200, result);
    }
    const data = await readCsv("candidates");
    const index = indexFromId(decodeURIComponent(candidateRoute[1]));
    if (index < 0 || index >= data.records.length) return sendError(res, 404, "Candidato non trovato");
    const [removed] = data.records.splice(index, 1);
    const headers = [...new Set([...data.headers, ...CANDIDATE_COLUMNS])];
    const write = await writeCsv("candidates", headers, data.records);
    const appData = await readCsv("applications");
    const removedName = removed.Title || "";
    const remainingApps = appData.records.filter((record) => normalizeToken(record.Candidate) !== normalizeToken(removedName));
    if (remainingApps.length !== appData.records.length) {
      const appHeaders = [...new Set([...appData.headers, ...APPLICATION_COLUMNS])];
      await writeCsv("applications", appHeaders, remainingApps);
    }
    return sendJson(res, 200, { item: mapCandidate(removed, index), ...write });
  }

  return sendError(res, 404, "Endpoint non trovato");
}

async function staticFile(req, res, url) {
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.normalize(path.join(publicDir, safePath));
  if (!resolved.startsWith(publicDir)) return sendError(res, 403, "Percorso non valido");
  const ext = path.extname(resolved).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  try {
    await fs.access(resolved);
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(resolved).pipe(res);
  } catch {
    sendError(res, 404, "File non trovato");
  }
}

export {
  parseCsv,
  serializeCsv,
  mapNeed,
  mapCandidate,
  scoreCandidateForNeed,
  dashboard,
  listNeeds,
  listCandidates,
  listApplications,
  createApplication,
  ensurePostgresSchema,
  importCsvToPostgres,
  pgQuery,
  sendTestNotificationMail
};

await loadEnv();

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT || 5173);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
        await api(req, res, url);
      } else {
        await staticFile(req, res, url);
      }
    } catch (error) {
      sendError(res, 500, "Errore interno", error.message);
    }
  });
  server.listen(port, () => {
    console.log(`Candidate & Needs Manager pronto su http://localhost:${port}`);
    if (usePostgres()) {
      const db = parseDatabaseUrl();
      console.log(`Backend dati: PostgreSQL (${db.host}:${db.port}/${db.database})`);
    } else {
      console.log("Backend dati: CSV");
      console.log(`Needs CSV: ${csvPath("needs")}`);
      console.log(`Candidates CSV: ${csvPath("candidates")}`);
      console.log(`Applications CSV: ${csvPath("applications")}`);
    }
  });
}
