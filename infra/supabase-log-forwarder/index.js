import express from "express";

const app = express();
app.use(express.json({ limit: "5mb" }));

function env(name, def = "") {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : def;
}

const apiKey = env("HONEYCOMB_API_KEY");
const dataset = env("HONEYCOMB_LOGS_DATASET", "homeops-prod-logs");
const logLevel = env("LOG_LEVEL", "INFO").toUpperCase();

function traceIdFromTraceparent(tp) {
  const s = String(tp || "").trim();
  const m = s.match(/^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i);
  return m ? m[1].toLowerCase() : "";
}

async function sendToHoneycomb(event) {
  if (!apiKey) throw new Error("Missing HONEYCOMB_API_KEY");
  const url = `https://api.honeycomb.io/1/events/${encodeURIComponent(dataset)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Honeycomb-Team": apiKey,
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => res.statusText);
    throw new Error(`Honeycomb events API error ${res.status}: ${t}`);
  }
}

function normalizeEvents(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    if (Array.isArray(body.events)) return body.events;
    if (Array.isArray(body.logs)) return body.logs;
    if (Array.isArray(body.entries)) return body.entries;
  }
  return [body];
}

app.post("/supabase/logs", async (req, res) => {
  const body = req.body;
  const events = normalizeEvents(body);

  let ok = 0;
  let failed = 0;
  const errors = [];

  for (const raw of events) {
    try {
      const e = raw && typeof raw === "object" ? { ...raw } : { message: String(raw) };

      const traceparent = e.traceparent || e.trace_parent || e["traceparent"] || "";
      const traceId = traceIdFromTraceparent(traceparent);
      if (traceId) e.trace_id = e.trace_id || traceId;

      if (!e.service_name && !e["service.name"]) e["service.name"] = "homeops-edge";
      if (!e.event) e.event = "supabase_log";

      await sendToHoneycomb(e);
      ok += 1;
    } catch (err) {
      failed += 1;
      if (logLevel !== "SILENT") {
        console.error("log_forward_failed", String(err && err.message ? err.message : err));
      }
      errors.push(String(err && err.message ? err.message : err));
    }
  }

  res.status(failed ? 207 : 200).json({ ok, failed, errors: errors.slice(0, 5) });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 8088);
app.listen(port, "0.0.0.0", () => {
  if (logLevel !== "SILENT") {
    console.log(JSON.stringify({ event: "log_forwarder_listening", port }));
  }
});
