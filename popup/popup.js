// popup/popup.js

const $ = id => document.getElementById(id);

// ─── Elements ─────────────────────────────────────────────────────────────────
const enableToggle  = $("enable-toggle");
const statusLabel   = $("status-label");
const pageStatus    = $("page-status");
const speedSlider   = $("speed-slider");
const speedValue    = $("speed-value");
const apiKeyInput   = $("api-key");
const toggleKeyBtn  = $("toggle-key");
const eyeIcon       = $("eye-icon");
const btnStart      = $("btn-start");
const btnStop       = $("btn-stop");
const btnStep       = $("btn-step");
const logArea       = $("log-area");
const clearLogBtn   = $("clear-log");
const statusCard    = document.querySelector(".status-card");
const modeBadge     = $("mode-badge");
const modeLabel     = $("mode-label");
const providerSelect = $("ai-provider");
const modelInput    = $("ai-model");
const keyLabel      = $("key-label");
const keyHint       = $("key-hint");
const modelHint     = $("model-hint");

let isRunning  = false;
let isVMMode   = false;

// ─── Provider config ──────────────────────────────────────────────────────────
const PROVIDER_CONFIG = {
  gemini: {
    label: "Gemini API Key",
    placeholder: "AIza...",
    hint: 'Get a free key at <a href="https://aistudio.google.com" target="_blank">aistudio.google.com</a>',
    defaultModel: "gemini-2.5-flash",
    storageKey: "apiKey"
  },
  openai: {
    label: "OpenAI API Key",
    placeholder: "sk-...",
    hint: 'Get a key at <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com</a>',
    defaultModel: "gpt-4o-mini",
    storageKey: "openaiKey"
  },
  openrouter: {
    label: "OpenRouter API Key",
    placeholder: "sk-or-...",
    hint: 'Get a free key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai</a>',
    defaultModel: "openai/gpt-4o-mini",
    storageKey: "openrouterKey"
  }
};

function applyProviderUI(provider) {
  const cfg = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.gemini;
  keyLabel.textContent = cfg.label;
  apiKeyInput.placeholder = cfg.placeholder;
  keyHint.innerHTML = cfg.hint;
  modelHint.textContent = `Default: ${cfg.defaultModel}`;
  // Load the saved key for this provider
  chrome.storage.sync.get([cfg.storageKey], (data) => {
    apiKeyInput.value = data[cfg.storageKey] || "";
  });
}

// ─── Speed labels ─────────────────────────────────────────────────────────────
const speedLabels = { "1": "Slow", "2": "Medium", "3": "Fast" };

// ─── Log helper ───────────────────────────────────────────────────────────────
function addLog(message, type = "info") {
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2,"0")}:${now.getMinutes().toString().padStart(2,"0")}:${now.getSeconds().toString().padStart(2,"0")}`;
  const entry = document.createElement("div");
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${time}] ${message}`;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;
}

// ─── Running state ────────────────────────────────────────────────────────────
function setRunningState(running) {
  isRunning = running;
  btnStart.disabled = running;
  btnStop.disabled  = !running;
  btnStep.disabled  = running;
  if (running) {
    statusLabel.textContent = isVMMode ? "Running VM…" : "Running…";
    statusCard.classList.add(isVMMode ? "running-vm" : "running");
    statusCard.classList.remove(isVMMode ? "running" : "running-vm");
  } else {
    statusLabel.textContent = "Ready";
    statusCard.classList.remove("running", "running-vm");
  }
}

// ─── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.sync.get(
  ["apiKey", "openaiKey", "openrouterKey", "provider", "model", "speed", "enabled"],
  (data) => {
    if (data.speed)    speedSlider.value = data.speed;
    if (data.enabled)  enableToggle.checked = data.enabled;
    speedValue.textContent = speedLabels[speedSlider.value] || "Medium";

    const savedProvider = data.provider || "gemini";
    providerSelect.value = savedProvider;
    applyProviderUI(savedProvider);

    if (data.model) modelInput.value = data.model;
  }
);

// ─── Save settings on change ──────────────────────────────────────────────────
providerSelect.addEventListener("change", () => {
  const provider = providerSelect.value;
  chrome.storage.sync.set({ provider });
  applyProviderUI(provider);
});

modelInput.addEventListener("input", () => {
  chrome.storage.sync.set({ model: modelInput.value });
});

apiKeyInput.addEventListener("input", () => {
  const provider = providerSelect.value;
  const cfg = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.gemini;
  // Always also save to "apiKey" as fallback
  const obj = { apiKey: apiKeyInput.value };
  obj[cfg.storageKey] = apiKeyInput.value;
  chrome.storage.sync.set(obj);
});

speedSlider.addEventListener("input", () => {
  speedValue.textContent = speedLabels[speedSlider.value];
  chrome.storage.sync.set({ speed: speedSlider.value });
});
enableToggle.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enableToggle.checked });
});

// ─── Toggle API key visibility ────────────────────────────────────────────────
toggleKeyBtn.addEventListener("click", () => {
  const isHidden = apiKeyInput.type === "password";
  apiKeyInput.type = isHidden ? "text" : "password";
  eyeIcon.innerHTML = isHidden
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
});

// ─── Detect page mode ─────────────────────────────────────────────────────────
function detectPageMode(url) {
  if (!url) return "unknown";
  if (url.includes("labondemand.com")) return "vm-lab";
  if (url.includes("cengage.com") || url.includes("mindtap")) return "mindtap";
  return "unknown";
}

// ─── Check current page & update badge ───────────────────────────────────────
async function checkCurrentPage() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { resolve(false); return; }
      const url = tab.url || "";
      const mode = detectPageMode(url);
      isVMMode = (mode === "vm-lab");

      if (mode === "vm-lab") {
        // Show orange VM Lab Mode badge
        modeBadge.classList.remove("mode-badge--hidden");
        modeLabel.textContent = "🖥️ VM Lab Mode";
        pageStatus.textContent = `✓ VM Lab detected — ${url.slice(0, 45)}...`;
        btnStep.title = "Execute current step only";
        resolve(true);
      } else if (mode === "mindtap") {
        modeBadge.classList.add("mode-badge--hidden");
        pageStatus.textContent = `✓ MindTap detected — ${url.slice(0, 45)}...`;
        resolve(true);
      } else {
        modeBadge.classList.add("mode-badge--hidden");
        pageStatus.textContent = `⚠ Not on a MindTap or VM lab page`;
        resolve(false);
      }
    });
  });
}

// ─── Send message to content script ──────────────────────────────────────────
async function sendToContent(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { resolve(null); return; }
      chrome.tabs.sendMessage(tab.id, { type, speed: speedSlider.value, ...extra }, (resp) => {
        if (chrome.runtime.lastError) {
          addLog("Could not reach content script. Refresh the page first.", "error");
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  });
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  if (!apiKeyInput.value.trim()) {
    const provider = providerSelect.value;
    const cfg = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.gemini;
    addLog(`Please enter your ${cfg.label} first.`, "warn");
    apiKeyInput.focus();
    return;
  }
  const onSupportedPage = await checkCurrentPage();
  if (!onSupportedPage) {
    addLog("Navigate to a MindTap activity or Cengage VM lab first.", "warn");
    return;
  }

  const provider = providerSelect.value;
  const model = modelInput.value.trim() || null;
  addLog(`Starting${isVMMode ? " VM lab" : ""} automation… [${provider}${model ? "/" + model : ""}]`, "info");
  setRunningState(true);

  if (isVMMode) {
    await sendToContent("START_VM_LAB");
  } else {
    await sendToContent("START_AUTOMATION");
  }
});

btnStop.addEventListener("click", async () => {
  addLog("Stopping automation…", "warn");
  await sendToContent("STOP_AUTOMATION");
  setRunningState(false);
});

btnStep.addEventListener("click", async () => {
  if (!apiKeyInput.value.trim()) {
    addLog("Please enter your Gemini API key first.", "warn");
    return;
  }
  addLog(isVMMode ? "Executing single VM step…" : "Stepping once…", "info");
  if (isVMMode) {
    await sendToContent("STEP_ONCE_VM");
  } else {
    await sendToContent("STEP_ONCE");
  }
});

clearLogBtn.addEventListener("click", () => {
  logArea.innerHTML = "";
  addLog("Log cleared.", "info");
});

// ─── Listen for status updates from content script ───────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    addLog(msg.message, msg.statusType || "info");

    const messageLC = (msg.message || "").toLowerCase();
    const completionPhrases = ["complete", "lab done", "🎉", "lab automation ended", "lab finished"];
    const stopPhrases = ["stopping", "stopped", "could not advance", "max iterations", "max steps", "cannot advance"];

    if (msg.statusType === "success" && completionPhrases.some(p => messageLC.includes(p))) {
      setRunningState(false);
    }
    if ((msg.statusType === "error" || msg.statusType === "warn") && stopPhrases.some(p => messageLC.includes(p))) {
      setRunningState(false);
    }
    if (msg.statusType === "warn" && (messageLC.includes("stopped by user") || messageLC.includes("stopped"))) {
      setRunningState(false);
    }
  }
});

// ─── Refresh page status on tab change ───────────────────────────────────────
chrome.tabs.onActivated.addListener(() => { try { checkCurrentPage(); } catch (_) {} });
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") { try { checkCurrentPage(); } catch (_) {} }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
checkCurrentPage();

