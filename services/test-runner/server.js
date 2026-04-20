const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cron = require("node-cron");
const { v4: uuidv4 } = require("uuid");
const Database = require("better-sqlite3");
const stripAnsi = require("strip-ansi");

const PORT = Number.parseInt(process.env.TEST_RUNNER_PORT || "4010", 10);
const REPO_ROOT = path.resolve(__dirname, "../..");

const DATA_DIR = process.env.TEST_RUNNER_DATA_DIR
  ? path.resolve(process.env.TEST_RUNNER_DATA_DIR)
  : path.join(os.homedir(), ".homeops-test-runner");

const DB_PATH = path.join(DATA_DIR, "runs.sqlite");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const REPORTS_DIR = path.join(DATA_DIR, "reports");

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

function openDb() {
  ensureDirs();
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      log_path TEXT NOT NULL,
      summary TEXT,
      report_path TEXT
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      type TEXT NOT NULL,
      mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_run_at TEXT
    );
  `);

  return db;
}

const db = openDb();

function ensureRunColumns() {
  const cols = db.prepare("PRAGMA table_info(runs)").all();
  const names = new Set(cols.map((c) => String(c.name)));
  if (!names.has("report_path")) {
    db.exec("ALTER TABLE runs ADD COLUMN report_path TEXT");
  }
}

ensureRunColumns();

const insertRunStmt = db.prepare(
  `INSERT INTO runs (id, type, mode, status, created_at, log_path, report_path)
   VALUES (@id, @type, @mode, @status, @created_at, @log_path, @report_path)`
);

const updateRunStartStmt = db.prepare(
  `UPDATE runs SET status=@status, started_at=@started_at WHERE id=@id`
);

const updateRunFinishStmt = db.prepare(
  `UPDATE runs SET status=@status, finished_at=@finished_at, exit_code=@exit_code, summary=@summary, report_path=@report_path WHERE id=@id`
);

const listRunsStmt = db.prepare(
  `SELECT * FROM runs ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
);

const getRunStmt = db.prepare(`SELECT * FROM runs WHERE id = ?`);

const insertScheduleStmt = db.prepare(
  `INSERT INTO schedules (id, name, cron_expr, enabled, type, mode, created_at)
   VALUES (@id, @name, @cron_expr, @enabled, @type, @mode, @created_at)`
);

const listSchedulesStmt = db.prepare(`SELECT * FROM schedules ORDER BY created_at DESC`);

const getScheduleStmt = db.prepare(`SELECT * FROM schedules WHERE id = ?`);

const updateScheduleStmt = db.prepare(
  `UPDATE schedules SET name=@name, cron_expr=@cron_expr, enabled=@enabled, type=@type, mode=@mode WHERE id=@id`
);

const deleteScheduleStmt = db.prepare(`DELETE FROM schedules WHERE id = ?`);

const updateScheduleLastRunStmt = db.prepare(
  `UPDATE schedules SET last_run_at=@last_run_at WHERE id=@id`
);

const activeJobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function runCommandForType(type, mode) {
  if (type === "vitest") {
    if (mode === "watch") return { cmd: "npm", args: ["run", "test:watch"] };
    if (mode === "ui") return { cmd: "npm", args: ["run", "test:ui"] };
    return { cmd: "npm", args: ["run", "test", "--", "--reporter=json"] };
  }

  if (type === "playwright") {
    if (mode === "ui") return { cmd: "npm", args: ["run", "e2e:ui"] };
    return { cmd: "npm", args: ["run", "e2e", "--", "--reporter=json"] };
  }

  throw new Error(`Unknown run type: ${type}`);
}

function summarizeFromOutput(output) {
  const s = stripAnsi(String(output || ""));

  const vitestMatch = s.match(/(Test Files\s+\d+[\s\S]*?Duration[\s\S]*?\n)/i);
  if (vitestMatch) return vitestMatch[1].trim();

  const pwMatch = s.match(/(\d+\s+passed[\s\S]*?(?:failed|skipped|flaky)?[\s\S]*?\n)/i);
  if (pwMatch) return pwMatch[1].trim();

  const tail = s.trim().split("\n").slice(-10).join("\n");
  return tail || null;
}

function extractJsonFromOutput(output) {
  const s = stripAnsi(String(output || ""));
  const start = s.indexOf("{");
  if (start === -1) return null;

  for (let i = start; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < s.length; j++) {
      const ch = s[j];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") depth++;
      if (ch === "}") depth--;

      if (depth === 0) {
        const candidate = s.slice(i, j + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

function extractVitestFailures(output) {
  const s = stripAnsi(String(output || ""));
  const lines = s.split("\n");

  const failures = new Map();
  let currentFile = null;
  let currentTest = null;
  let currentBlock = [];

  const flush = () => {
    if (!currentFile || !currentTest || currentBlock.length === 0) return;
    const arr = failures.get(currentFile) || [];
    arr.push({ test: currentTest, details: currentBlock.join("\n").trim() });
    failures.set(currentFile, arr);
    currentBlock = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fileHeader = line.match(/^\s*FAIL\s+(.+?)\s*$/);
    if (fileHeader) {
      flush();
      currentFile = fileHeader[1].trim();
      currentTest = null;
      currentBlock = [];
      continue;
    }

    if (!currentFile) continue;

    const testHeader = line.match(/^\s*[›>]+\s*(.+?)\s*$/);
    if (testHeader) {
      flush();
      currentTest = testHeader[1].trim();
      currentBlock = [];
      continue;
    }

    if (/^\s*Test Files\s+/i.test(line)) {
      flush();
      currentFile = null;
      currentTest = null;
      currentBlock = [];
      continue;
    }

    if (currentTest) {
      if (line.trim() === "") {
        const next = lines[i + 1] || "";
        if (/^\s*[›>]+\s*/.test(next) || /^\s*FAIL\s+/.test(next) || /^\s*Test Files\s+/i.test(next)) {
          flush();
          continue;
        }
      }
      currentBlock.push(line);
    }
  }

  flush();
  return failures;
}

function formatFailureReport({ type, status, combinedOutput }) {
  const out = stripAnsi(String(combinedOutput || ""));

  if (status !== "failed") {
    const summary = summarizeFromOutput(out);
    return summary ? `Summary\n${summary}` : null;
  }

  if (type === "vitest") {
    const failures = extractVitestFailures(out);
    const parts = [];
    const summary = summarizeFromOutput(out);
    if (summary) parts.push(`Summary\n${summary}`);

    if (failures.size === 0) {
      const tail = out.trim().split("\n").slice(-40).join("\n");
      parts.push(`Failures\n${tail}`);
      return parts.join("\n\n");
    }

    parts.push("Failures (grouped by test file)");
    for (const [file, items] of failures.entries()) {
      parts.push(`\n${file}`);
      for (const it of items) {
        parts.push(`\n- ${it.test}`);
        if (it.details) {
          parts.push(it.details.split("\n").map((l) => `  ${l}`).join("\n"));
        }
      }
    }

    return parts.join("\n").trim();
  }

  const summary = summarizeFromOutput(out);
  const tail = out.trim().split("\n").slice(-60).join("\n");
  return [summary ? `Summary\n${summary}` : null, `Failures\n${tail}`].filter(Boolean).join("\n\n");
}

function startRun({ type, mode, scheduleId }) {
  const id = uuidv4();
  const logPath = path.join(LOGS_DIR, `${id}.log`);
  const reportPath = path.join(REPORTS_DIR, `${id}.json`);

  insertRunStmt.run({
    id,
    type,
    mode,
    status: "queued",
    created_at: nowIso(),
    log_path: logPath,
    report_path: null,
  });

  const { cmd, args } = runCommandForType(type, mode);

  const outStream = fs.createWriteStream(logPath, { flags: "a" });
  outStream.write(`[homeops-test-runner] run ${id} queued\n`);
  outStream.write(`[homeops-test-runner] cwd=${REPO_ROOT}\n`);
  outStream.write(`[homeops-test-runner] cmd=${cmd} ${args.join(" ")}\n`);

  updateRunStartStmt.run({ id, status: "running", started_at: nowIso() });

  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env: { ...process.env },
    shell: false,
  });

  activeJobs.set(id, child);

  let combined = "";
  const onChunk = (chunk) => {
    const text = chunk.toString();
    combined += text;
    outStream.write(text);
  };

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  child.on("close", (code) => {
    activeJobs.delete(id);
    outStream.write(`\n[homeops-test-runner] finished exit_code=${code}\n`);

    const ok = code === 0;
    const reportWrittenPath = writeStructuredReport({ type, combinedOutput: combined, reportPath });
    const report = formatFailureReport({ type, status: ok ? "passed" : "failed", combinedOutput: combined });
    if (report) {
      outStream.write("\n\n[homeops-test-runner] report\n");
      outStream.write("------------------------------------------------------------\n");
      outStream.write(`${report}\n`);
    }
    outStream.end();

    const summary = summarizeFromOutput(combined);
    updateRunFinishStmt.run({
      id,
      status: ok ? "passed" : "failed",
      finished_at: nowIso(),
      exit_code: code,
      summary: summary ? stripAnsi(String(summary)) : null,
      report_path: reportWrittenPath,
    });

    if (scheduleId) {
      updateScheduleLastRunStmt.run({ id: scheduleId, last_run_at: nowIso() });
    }
  });

  child.on("error", (err) => {
    activeJobs.delete(id);
    outStream.write(`\n[homeops-test-runner] error: ${String(err)}\n`);

    const report = formatFailureReport({ type, status: "failed", combinedOutput: String(err) });
    if (report) {
      outStream.write("\n\n[homeops-test-runner] report\n");
      outStream.write("------------------------------------------------------------\n");
      outStream.write(`${report}\n`);
    }
    outStream.end();

    updateRunFinishStmt.run({
      id,
      status: "failed",
      finished_at: nowIso(),
      exit_code: null,
      summary: stripAnsi(String(err)),
      report_path: null,
    });
  });

  return { id };
}

function validateRunBody(body) {
  const type = typeof body?.type === "string" ? body.type : "";
  const mode = typeof body?.mode === "string" ? body.mode : "run";

  if (!type || (type !== "vitest" && type !== "playwright")) {
    return { ok: false, error: "type must be 'vitest' or 'playwright'" };
  }

  if (mode !== "run" && mode !== "ui" && mode !== "watch") {
    return { ok: false, error: "mode must be 'run', 'ui', or 'watch'" };
  }

  if (type === "playwright" && mode === "watch") {
    return { ok: false, error: "playwright does not support watch mode" };
  }

  return { ok: true, type, mode };
}

function validateScheduleBody(body) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const cronExpr = typeof body?.cron_expr === "string" ? body.cron_expr.trim() : "";
  const enabled = typeof body?.enabled === "boolean" ? body.enabled : true;

  const runValidation = validateRunBody(body);
  if (!runValidation.ok) return runValidation;

  if (!name) return { ok: false, error: "name is required" };
  if (!cronExpr) return { ok: false, error: "cron_expr is required" };
  if (!cron.validate(cronExpr)) return { ok: false, error: "invalid cron expression" };

  return {
    ok: true,
    name,
    cron_expr: cronExpr,
    enabled,
    type: runValidation.type,
    mode: runValidation.mode,
  };
}

function scheduleKey(scheduleId) {
  return `schedule:${scheduleId}`;
}

function installScheduleJob(scheduleRow) {
  const key = scheduleKey(scheduleRow.id);

  const existing = activeJobs.get(key);
  if (existing) {
    try {
      existing.stop();
    } catch {
      // ignore
    }
    activeJobs.delete(key);
  }

  if (!scheduleRow.enabled) return;

  const job = cron.schedule(scheduleRow.cron_expr, () => {
    try {
      startRun({ type: scheduleRow.type, mode: scheduleRow.mode, scheduleId: scheduleRow.id });
    } catch {
      // ignore
    }
  });

  activeJobs.set(key, job);
}

function loadSchedules() {
  const schedules = listSchedulesStmt.all();
  for (const s of schedules) {
    installScheduleJob(s);
  }
}

loadSchedules();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/runs", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit || "25"), 10) || 25));
  const offset = Math.max(0, Number.parseInt(String(req.query.offset || "0"), 10) || 0);
  const runs = listRunsStmt.all({ limit, offset });
  res.json({ ok: true, runs });
});

app.get("/runs/:id", (req, res) => {
  const run = getRunStmt.get(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: "not found" });
  res.json({ ok: true, run });
});

app.get("/runs/:id/log", (req, res) => {
  const run = getRunStmt.get(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: "not found" });

  const logPath = String(run.log_path || "");
  if (!logPath) return res.status(404).json({ ok: false, error: "log not found" });

  try {
    const content = fs.readFileSync(logPath, "utf8");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(content);
  } catch {
    return res.status(404).json({ ok: false, error: "log not found" });
  }
});

app.get("/runs/:id/report", (req, res) => {
  const run = getRunStmt.get(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: "not found" });

  const reportPath = run.report_path ? String(run.report_path) : "";
  if (!reportPath) return res.status(404).json({ ok: false, error: "report not found" });

  try {
    const content = fs.readFileSync(reportPath, "utf8");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(content);
  } catch {
    return res.status(404).json({ ok: false, error: "report not found" });
  }
});

app.post("/runs", (req, res) => {
  const validation = validateRunBody(req.body);
  if (!validation.ok) return res.status(400).json(validation);

  try {
    const { id } = startRun({ type: validation.type, mode: validation.mode });
    return res.json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/runs/:id/cancel", (req, res) => {
  const id = String(req.params.id);
  const child = activeJobs.get(id);
  if (!child) return res.status(404).json({ ok: false, error: "run not running" });

  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }

  return res.json({ ok: true });
});

app.get("/schedules", (_req, res) => {
  const schedules = listSchedulesStmt.all();
  res.json({ ok: true, schedules });
});

app.post("/schedules", (req, res) => {
  const validation = validateScheduleBody(req.body);
  if (!validation.ok) return res.status(400).json(validation);

  const id = uuidv4();
  const row = {
    id,
    name: validation.name,
    cron_expr: validation.cron_expr,
    enabled: validation.enabled ? 1 : 0,
    type: validation.type,
    mode: validation.mode,
    created_at: nowIso(),
  };

  try {
    insertScheduleStmt.run(row);
    const schedule = getScheduleStmt.get(id);
    installScheduleJob(schedule);
    return res.json({ ok: true, schedule });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.put("/schedules/:id", (req, res) => {
  const schedule = getScheduleStmt.get(req.params.id);
  if (!schedule) return res.status(404).json({ ok: false, error: "not found" });

  const validation = validateScheduleBody(req.body);
  if (!validation.ok) return res.status(400).json(validation);

  const row = {
    id: schedule.id,
    name: validation.name,
    cron_expr: validation.cron_expr,
    enabled: validation.enabled ? 1 : 0,
    type: validation.type,
    mode: validation.mode,
  };

  try {
    updateScheduleStmt.run(row);
    const updated = getScheduleStmt.get(schedule.id);
    installScheduleJob(updated);
    return res.json({ ok: true, schedule: updated });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.delete("/schedules/:id", (req, res) => {
  const schedule = getScheduleStmt.get(req.params.id);
  if (!schedule) return res.status(404).json({ ok: false, error: "not found" });

  try {
    deleteScheduleStmt.run(schedule.id);
    installScheduleJob({ ...schedule, enabled: 0 });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`[homeops-test-runner] listening on http://localhost:${PORT}`);
  console.log(`[homeops-test-runner] data dir: ${DATA_DIR}`);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[homeops-test-runner] port ${PORT} already in use. Stop the existing runner or set TEST_RUNNER_PORT.`);
    process.exit(1);
  }
  console.error(String(err));
  process.exit(1);
});
