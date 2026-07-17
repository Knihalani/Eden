const STORAGE_KEY = "eden-openrouter-smoke-agent:v1";

const els = {
  health: document.getElementById("health-pill"),
  openRouterKey: document.getElementById("openrouter-key"),
  model: document.getElementById("model"),
  edenOrg: document.getElementById("eden-org"),
  edenKey: document.getElementById("eden-key"),
  edenBase: document.getElementById("eden-base"),
  edenProject: document.getElementById("eden-project"),
  saveLocal: document.getElementById("save-local"),
  transcript: document.getElementById("transcript"),
  form: document.getElementById("chat-form"),
  message: document.getElementById("message"),
  send: document.getElementById("send"),
  status: document.getElementById("status"),
  events: document.getElementById("events"),
};

function addBubble(role, text) {
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  div.textContent = text;
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function readForm() {
  return {
    openRouterApiKey: els.openRouterKey.value.trim(),
    model: els.model.value.trim(),
    edenOrgId: els.edenOrg.value.trim(),
    edenApiKey: els.edenKey.value.trim(),
    edenBaseUrl: els.edenBase.value.trim(),
    edenProjectId: els.edenProject.value.trim(),
  };
}

function writeForm(data) {
  if (data.openRouterApiKey != null) els.openRouterKey.value = data.openRouterApiKey;
  if (data.model != null) els.model.value = data.model;
  if (data.edenOrgId != null) els.edenOrg.value = data.edenOrgId;
  if (data.edenApiKey != null) els.edenKey.value = data.edenApiKey;
  if (data.edenBaseUrl != null) els.edenBase.value = data.edenBaseUrl;
  if (data.edenProjectId != null) els.edenProject.value = data.edenProjectId;
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

els.saveLocal.addEventListener("click", () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(readForm()));
  setStatus("Saved credentials in this browser.");
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = els.message.value.trim();
  if (!message) return;

  const config = readForm();
  if (!config.openRouterApiKey) {
    setStatus("OpenRouter API key is required.", true);
    return;
  }
  if (!config.model) {
    setStatus("Model id is required.", true);
    return;
  }
  if (!config.edenOrgId || !config.edenApiKey) {
    setStatus("Eden org id and API key are required to hit prod.", true);
    return;
  }

  addBubble("user", message);
  els.message.value = "";
  els.send.disabled = true;
  setStatus("Running agent…");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...config, userId: "smoke-tester" }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    addBubble("assistant", data.reply || "(empty)");
    addBubble(
      "meta",
      [
        `session ${data.sessionId}`,
        `model ${data.model}`,
        `${data.llmRounds} llm round(s)`,
        `${data.toolCalls} tool call(s)`,
        `${data.durationMs} ms`,
        data.portalTracesUrl || "https://edenobservability.com/traces",
      ].join(" · "),
    );
    els.events.textContent = JSON.stringify(data.events, null, 2);
    setStatus("Done — check prod traces.");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    addBubble("meta", `error: ${text}`);
    setStatus(text, true);
  } finally {
    els.send.disabled = false;
  }
});

async function boot() {
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    els.health.textContent = health.ok ? "local ok · sdk live" : "unhealthy";
    els.health.classList.toggle("ok", Boolean(health.ok));
  } catch {
    els.health.textContent = "server down";
    els.health.classList.add("bad");
  }

  const defaults = await fetch("/api/defaults")
    .then((r) => r.json())
    .catch(() => ({}));
  const local = loadLocal() || {};

  writeForm({
    openRouterApiKey: local.openRouterApiKey || defaults.openRouterApiKey || "",
    model: local.model || defaults.model || "openai/gpt-4o-mini",
    edenOrgId: local.edenOrgId || defaults.edenOrgId || "",
    edenApiKey: local.edenApiKey || defaults.edenApiKey || "",
    edenBaseUrl:
      local.edenBaseUrl ||
      defaults.edenBaseUrl ||
      "https://api.edenobservability.com",
    edenProjectId:
      local.edenProjectId ||
      defaults.edenProjectId ||
      "openrouter-smoke-agent",
  });
}

boot();
