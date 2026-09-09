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

let isRunning = false;

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

// ─── Status update ────────────────────────────────────────────────────────────
function setRunningState(running) {
  isRunning = running;
  btnStart.disabled = running;
  btnStop.disabled  = !running;
  btnStep.disabled  = running;
  if (running) {
    statusLabel.textContent = "Running…";
    statusCard.classList.add("running");
  } else {
    statusLabel.textContent = "Ready";
    statusCard.classList.remove("running");
  }
}

// ─── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.sync.get(["apiKey", "speed", "enabled"], (data) => {
  if (data.apiKey)  apiKeyInput.value = data.apiKey;
  if (data.speed)   speedSlider.value = data.speed;
  if (data.enabled) enableToggle.checked = data.enabled;
  speedValue.textContent = speedLabels[speedSlider.value] || "Medium";
});

// ─── Save settings on change ──────────────────────────────────────────────────
apiKeyInput.addEventListener("input", () => {
  chrome.storage.sync.set({ apiKey: apiKeyInput.value });
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

// ─── Send message to content script ──────────────────────────────────────────
async function sendToContent(type, extra = {}) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { resolve(null); return; }

      chrome.tabs.sendMessage(tab.id, { type, speed: speedSlider.value, ...extra }, (resp) => {
        if (chrome.runtime.lastError) {
          addLog("Could not reach content script. Refresh the MindTap page.", "error");
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  });
}

// ─── Check if on MindTap ─────────────────────────────────────────────────────
async function checkCurrentPage() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { resolve(false); return; }
      const url = tab.url || "";
      const isMindTap = url.includes("cengage.com") || url.includes("mindtap");
      pageStatus.textContent = isMindTap
        ? `✓ MindTap detected — ${url.slice(0, 50)}...`
        : `⚠ Not on a MindTap page`;
      resolve(isMindTap);
    });
  });
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  if (!apiKeyInput.value.trim()) {
    addLog("Please enter your Gemini API key first.", "warn");
    apiKeyInput.focus();
    return;
  }
  const onMindTap = await checkCurrentPage();
  if (!onMindTap) {
    addLog("Navigate to a MindTap activity page first.", "warn");
    return;
  }
  addLog("Starting automation…", "info");
  setRunningState(true);
  await sendToContent("START_AUTOMATION");
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
  addLog("Stepping once…", "info");
  await sendToContent("STEP_ONCE");
});

clearLogBtn.addEventListener("click", () => {
  logArea.innerHTML = "";
  addLog("Log cleared.", "info");
});

// ─── Listen for status updates from content script ───────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS_UPDATE") {
    addLog(msg.message, msg.statusType || "info");
    // Detect completion
    if (msg.statusType === "success" && msg.message.includes("complete")) {
      setRunningState(false);
    }
    if (msg.statusType === "error" && msg.message.includes("stopping")) {
      setRunningState(false);
    }
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
checkCurrentPage();
