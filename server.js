/* CommonJS version for older Node; no optional chaining */
const express = require("express");
const fetch = require("node-fetch");
const AbortController = global.AbortController || require("abort-controller");
const fs = require("fs/promises");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Serve static and HTML
app.use("/static", express.static(path.join(__dirname, "static")));
app.get("/", async (req, res) => {
  try {
    const html = await fs.readFile(path.join(__dirname, "templates", "index.html"), "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    res.status(500).send("Fehler beim Laden der Seite.");
  }
});

// Prompt helpers
const PROMPT_PATH_LEICHTE = path.join(__dirname, "system_prompt_leichte.txt");
const PROMPT_PATH_EINFACHE = path.join(__dirname, "system_prompt_einfache.txt");
const CLEANUP_PROMPT_PATH = path.join(__dirname, "system_prompt_cleanup.txt");

const PROMPT_FILES = {
  leichte: PROMPT_PATH_LEICHTE,
  einfache: PROMPT_PATH_EINFACHE,
  cleanup: CLEANUP_PROMPT_PATH
};

const PROMPT_DEFAULTS = {
  leichte: "Du bist Übersetzer für Leichte Sprache. Verwende sehr einfache Wörter, kurze aktive Sätze, ein Gedanke pro Satz. Verdichte stark und lasse Unwichtiges weg. Keine Fach-/Fremdwörter, keine Abkürzungen, kein Genitiv/Konjunktiv, keine Substantivierungen. Ausgabe nur die Übersetzung.",
  einfache: "Du bist Übersetzer für Einfache Sprache. Schreibe klar, direkt, mit kurzen Sätzen. Verdichte stark und lasse Unwichtiges weg. Keine Fach-/Fremdwörter, keine Abkürzungen. Ausgabe nur die Übersetzung.",
  cleanup: "Du bist eine erfahrene Lehrkraft an einem SBBZ. Kolleginnen oder Assistenzen mit unsicherem Deutsch geben dir chaotische Notizen. Formuliere daraus fehlerfreie, professionelle Texte in neutraler, leicht zugänglicher Sprache und antworte nur mit dem überarbeiteten Text."
};

function normalizePromptType(type) {
  const t = (type || "leichte").toLowerCase();
  if (PROMPT_FILES[t]) return t;
  return "leichte";
}

// Read prompt by type
async function readPromptByType(type) {
  const key = normalizePromptType(type);
  const file = PROMPT_FILES[key];
  try {
    return await fs.readFile(file, "utf-8");
  } catch (e) {
    return PROMPT_DEFAULTS[key];
  }
}

// Optional: write prompt by type (used by /system_prompt editor)
async function writePromptByType(type, text) {
  const key = normalizePromptType(type);
  const file = PROMPT_FILES[key];
  await fs.writeFile(file, text, "utf-8");
}

// GET system prompt (by type)
app.get("/system_prompt", async (req, res) => {
  try {
    const type = (req.query.type || "leichte").toLowerCase();
    const prompt = await readPromptByType(type);
    res.json({ type, prompt });
  } catch (e) {
    res.status(500).json({ error: "Fehler beim Lesen des Prompts." });
  }
});

// POST system prompt (update by type)
app.post("/system_prompt", async (req, res) => {
  try {
    const body = req.body || {};
    const type = (body.type || "leichte").toLowerCase();
    const prompt = body.prompt;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 10) {
      return res.status(400).json({ error: "Prompt ist zu kurz oder ungültig." });
    }
    await writePromptByType(type, prompt);
    res.json({ ok: true, type });
  } catch (e) {
    res.status(500).json({ error: "Fehler beim Speichern des Prompts." });
  }
});

// Helper: build messages including mode line
function buildMessages(userText, systemPrompt, type) {
  const t = (type || "leichte").toLowerCase();
  const modeLine = t === "einfache"
    ? "Übersetze in Einfache Sprache. Verdichte stark. Unwichtiges weglassen."
    : "Übersetze in Leichte Sprache. Verdichte stark. Unwichtiges weglassen.";
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: modeLine + "\n\n" + userText }
  ];
}

async function buildCleanupMessages(userText) {
  const prompt = await readPromptByType("cleanup");
  return [
    { role: "system", content: prompt },
    { role: "user", content: "Überarbeite diesen Text:\n\n" + userText }
  ];
}

// Env
const API_BASE = process.env.OPENWEBUI_API_BASE || "https://api.mistral.ai/v1";
const API_KEY = process.env.OPENWEBUI_API_KEY || "";
const MODEL = process.env.OPENWEBUI_MODEL || "mistral-small-latest";
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT || 120) * 1000;

// Non-streaming
app.post("/paraphrase", async (req, res) => {
  const body = req.body || {};
  const text = body.text;
  const promptType = (body.promptType || "leichte").toLowerCase();
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Kein Text bereitgestellt." });
  }
  try {
    const systemPrompt = await readPromptByType(promptType);
    const payload = {
      model: MODEL,
      messages: buildMessages(text, systemPrompt, promptType)
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    const r = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText });
    }
    const data = await r.json();
    // avoid optional chaining for older Node
    let content = "";
    try {
      if (data && data.choices && data.choices[0] && data.choices[0].message && typeof data.choices[0].message.content === "string") {
        content = data.choices[0].message.content;
      }
    } catch {}
    return res.json({ result: content });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Timeout beim Modell." : (e && e.message) || "Unbekannter Fehler";
    return res.status(504).json({ error: msg });
  }
});

app.post("/cleanup", async (req, res) => {
  const body = req.body || {};
  const text = body.text;
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: "Kein Text bereitgestellt." });
  }
  try {
    const payload = {
      model: MODEL,
      messages: await buildCleanupMessages(text)
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    const r = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!r.ok) {
      const errText = await r.text();
      return res.status(r.status).json({ error: errText });
    }
    const data = await r.json();
    let content = "";
    try {
      if (data && data.choices && data.choices[0] && data.choices[0].message && typeof data.choices[0].message.content === "string") {
        content = data.choices[0].message.content;
      }
    } catch {}
    return res.json({ result: content });
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Timeout beim Modell." : (e && e.message) || "Unbekannter Fehler";
    return res.status(504).json({ error: msg });
  }
});

// Streaming paraphrase: stream the full accumulated text buffer, not tiny deltas
app.post("/paraphrase_stream", async (req, res) => {
  const body = req.body || {};
  const text = body.text;
  const promptType = (body.promptType || "leichte").toLowerCase();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  // Flush headers early (important for some proxies)
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  if (!text || !String(text).trim()) {
    res.write("data: ERROR: Kein Text bereitgestellt.\n\n");
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  try {
    const systemPrompt = await readPromptByType(promptType);
    const payload = {
      model: MODEL,
      messages: buildMessages(text, systemPrompt, promptType),
      stream: true
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

    const r = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!r.ok) {
      clearTimeout(timer);
      const errText = await r.text();
      res.write("data: ERROR: " + errText.replace(/\n/g, " ") + "\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    let buffer = "";
    let acc = ""; // accumulated full text

    const pushFull = () => {
      // Stream the entire buffer as-is (including spaces/newlines)
      res.write("data: " + JSON.stringify(acc) + "\n\n");
    };

    if (r.body && typeof r.body.getReader === "function") {
      const reader = r.body.getReader();
      const decoder = new TextDecoder("utf-8");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const ev of events) {
          const m = ev.match(/^data:\s*(.*)$/s);
          if (!m) continue;
          const payloadStr = m[1];
          if (payloadStr === "[DONE]") {
            clearTimeout(timer);
            pushFull();
            res.write("data: [DONE]\n\n");
            return res.end();
          }
          try {
            const obj = JSON.parse(payloadStr);
            // Mistral/OpenAI delta shape
            const choice = obj && obj.choices && obj.choices[0];
            const delta = choice && choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "";
            if (delta) {
              acc += delta; // append exact chunk
              pushFull();
            }
          } catch {
            // Some backends stream raw text; append as-is
            acc += payloadStr;
            pushFull();
          }
        }
      }
    } else if (r.body && r.body[Symbol.asyncIterator]) {
      for await (const chunk of r.body) {
        buffer += chunk.toString();
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const ev of events) {
          const m = ev.match(/^data:\s*(.*)$/s);
          if (!m) continue;
          const payloadStr = m[1];
          if (payloadStr === "[DONE]") {
            clearTimeout(timer);
            pushFull();
            res.write("data: [DONE]\n\n");
            return res.end();
          }
          try {
            const obj = JSON.parse(payloadStr);
            const choice = obj && obj.choices && obj.choices[0];
            const delta = choice && choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "";
            if (delta) {
              acc += delta;
              pushFull();
            }
          } catch {
            acc += payloadStr;
            pushFull();
          }
        }
      }
    } else {
      const textAll = await r.text();
      clearTimeout(timer);
      acc += textAll;
      pushFull();
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    clearTimeout(timer);
    pushFull();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Timeout beim Modell." : (e && e.message) || "Unbekannter Fehler";
    res.write("data: ERROR: " + msg + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

// GET variant for environments disallowing POST to SSE routes
app.get("/paraphrase_stream", async (req, res) => {
  const text = (req.query && req.query.text) ? String(req.query.text) : "";
  const promptType = (req.query && req.query.promptType) ? String(req.query.promptType).toLowerCase() : "leichte";

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  if (!text || !text.trim()) {
    res.write("data: ERROR: Kein Text bereitgestellt.\n\n");
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  try {
    const systemPrompt = await readPromptByType(promptType);
    const payload = {
      model: MODEL,
      messages: buildMessages(text, systemPrompt, promptType),
      stream: true
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);

    const r = await fetch(API_BASE + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!r.ok) {
      clearTimeout(timer);
      const errText = await r.text();
      res.write("data: ERROR: " + errText.replace(/\n/g, " ") + "\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    let buffer = "";
    let acc = "";
    const pushFull = () => { res.write("data: " + JSON.stringify(acc) + "\n\n"); };

    if (r.body && r.body[Symbol.asyncIterator]) {
      for await (const chunk of r.body) {
        buffer += chunk.toString();
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const ev of events) {
          const m = ev.match(/^data:\s*(.*)$/s);
          if (!m) continue;
          const payloadStr = m[1];
          if (payloadStr === "[DONE]") {
            clearTimeout(timer);
            pushFull();
            res.write("data: [DONE]\n\n");
            return res.end();
          }
          try {
            const obj = JSON.parse(payloadStr);
            const choice = obj && obj.choices && obj.choices[0];
            const delta = choice && choice.delta && typeof choice.delta.content === "string" ? choice.delta.content : "";
            if (delta) { acc += delta; pushFull(); }
          } catch { acc += payloadStr; pushFull(); }
        }
      }
    } else {
      const textAll = await r.text();
      clearTimeout(timer);
      acc += textAll;
      pushFull();
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    clearTimeout(timer);
    pushFull();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Timeout beim Modell." : (e && e.message) || "Unbekannter Fehler";
    res.write("data: ERROR: " + msg + "\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log("Server listening on http://" + HOST + ":" + PORT);
});
