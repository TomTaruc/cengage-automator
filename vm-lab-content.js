// =============================================================================
// Cengage VM Lab Automator — vm-lab-content.js
// Runs on labclient.labondemand.com (Lab on Demand / Cengage virtual labs).
//
// Architecture:
//   1. Reads step instructions from the Cengage right panel
//   2. Sends them to Gemini AI to get a list of keyboard/type actions
//   3. Executes those actions (Type Text button + clipboard injection + key events)
//   4. Clicks "Next" in the Cengage panel and repeats
// =============================================================================

(function () {
  "use strict";

  // Broad injection allows this script to enter all iframes (including cross-origin LOD frames)
  // We don't block by hostname anymore because LOD uses many random iframe domains (skillable.com, etc)
  
  // ─── State ─────────────────────────────────────────────────────────────────
  let isRunning     = false;
  let stopRequested = false;
  let currentSpeed  = 1500;

  // ─── Utilities ─────────────────────────────────────────────────────────────
  function delay(ms) {
    return new Promise(r => setTimeout(r, Math.max(ms, 80)));
  }

  function sendStatus(message, type = "info") {
    try { chrome.runtime.sendMessage({ type: "STATUS_UPDATE", message, statusType: type }); } catch (_) {}
    console.log(`[VM-Automator][${type.toUpperCase()}] ${message}`);
  }

  function speedToMs(speed) {
    switch (parseInt(speed, 10)) {
      case 3: return 600;
      case 2: return 1500;
      default: return 2500;
    }
  }

  // ─── DOM Helpers ────────────────────────────────────────────────────────────
  function findFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function waitForEl(selectors, timeout = 5000) {
    return new Promise(resolve => {
      const found = findFirst(selectors);
      if (found) return resolve(found);
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) { settled = true; obs.disconnect(); resolve(null); }
      }, timeout);
      const obs = new MutationObserver(() => {
        const el = findFirst(selectors);
        if (el && !settled) {
          settled = true;
          clearTimeout(t);
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    });
  }

  // ─── Selectors ───────────────────────────────────────────────────────────────

  // Cengage instruction panel (right side on LOD pages)
  const STEP_TEXT_SELECTORS = [
    // LOD / Skillable specific
    ".instructions-content",
    ".lab-instructions",
    "#instructions-tab-content",
    ".lod-instructions",
    // Cengage generic
    "[class*='instruction-content']",
    "[class*='instructions-panel']",
    "[class*='step-content']",
    "[class*='task-content']",
    "[class*='activity-instructions']",
    ".cengage-panel",
    "[data-instructions]",
    ".panel-body",
    "#instructions",
    ".instruction"
  ];

  const ACTIVE_STEP_SELECTORS = [
    "[class*='active'][class*='step']",
    "[class*='current'][class*='step']",
    "[class*='step'].active",
    "[aria-current='step']",
    "[class*='step-active']",
    "li.active",
    ".current-step",
    "[class*='active-task']"
  ];

  const NEXT_BTN_SELECTORS = [
    "button[class*='next']",
    "[class*='next-btn']",
    "[class*='btn-next']",
    "button[aria-label='Next']",
    "button[title='Next']",
    ".next-step",
    "[data-action='next']",
    "[class*='step-next']",
    // LOD specific
    ".lod-next-button",
    "button.btn-primary"
  ];

  // Cengage "Type Text" clipboard icon — injects text into the VM
  const TYPE_TEXT_BTN_SELECTORS = [
    "[title='Type Text']",
    "[aria-label='Type Text']",
    "[title*='Type Text']",
    "[class*='typetext']:not(input)",
    "[class*='type-text']:not(input)",
    "[data-action*='typetext']",
    ".fa-keyboard",
    "button[title*='keyboard']",
    // Broader fallback
    "[class*='clipboard']",
    ".fa-clipboard"
  ];

  // Input in the Type Text dialog
  const TYPE_TEXT_INPUT_SELECTORS = [
    "[class*='typetext'] textarea",
    "[class*='typetext'] input[type='text']",
    "[class*='type-text'] textarea",
    "[class*='type-text'] input[type='text']",
    "dialog textarea",
    "dialog input[type='text']",
    ".modal textarea",
    ".modal input[type='text']",
    "[role='dialog'] textarea",
    "[role='dialog'] input[type='text']"
  ];

  const TYPE_TEXT_SUBMIT_SELECTORS = [
    "[class*='typetext'] button[class*='submit']",
    "[class*='typetext'] button[class*='ok']",
    "[class*='typetext'] button[class*='confirm']",
    "[class*='typetext'] button[class*='enter']",
    "dialog button[class*='ok']",
    "dialog button[class*='submit']",
    "dialog button[class*='confirm']",
    "[role='dialog'] button[class*='ok']",
    "[role='dialog'] button[class*='primary']"
  ];

  // VM remote desktop canvas or display element
  const VM_CANVAS_SELECTORS = [
    "canvas#vmDisplay",
    "canvas.vm-display",
    "canvas",
    "[class*='vm-screen'] canvas",
    "[class*='remote-display'] canvas",
    "[class*='console'] canvas",
    "iframe[class*='vm']",
    "iframe[id*='vm']",
    "iframe[id*='machine']",
    "iframe[src*='vm']"
  ];

  // ─── Noise patterns to strip from step text ─────────────────────────────────
  // BUG-10 FIX: Remove UI noise before sending to AI
  const NOISE_PATTERNS = [
    /hints?\s+enabled/gi,
    /\d+\s+minutes?\s+remaining/gi,
    /\d+:\d+\s+remaining/gi,
    /instructions?\s+resources?/gi,
    /previous\s+next/gi,
    /show\s+hints?/gi,
    /expand\s+this\s+hint/gi,
    /^resources?\s*$/gim,
    /^instructions?\s*$/gim
  ];

  function cleanStepText(raw) {
    if (!raw) return "";
    let text = raw;
    for (const pattern of NOISE_PATTERNS) {
      text = text.replace(pattern, "");
    }
    // Collapse excess whitespace
    return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
  }

  // ─── Read Current Step ──────────────────────────────────────────────────────
  function getActiveStepInstruction() {
    // Try to get just the current/active step
    for (const sel of ACTIVE_STEP_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText?.trim().length > 10) {
          return cleanStepText(el.innerText.trim());
        }
      } catch (_) {}
    }
    return null; 
  }

  function getFullPanelText() {
    for (const sel of STEP_TEXT_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText?.trim().length > 20) {
          return cleanStepText(el.innerText.trim());
        }
      } catch (_) {}
    }
    
    // If we are inside an iframe, just grab the whole body text if it's substantial
    if (window.self !== window.top) {
      const text = document.body.innerText?.trim();
      if (text && text.length > 80) return cleanStepText(text);
    }

    // Last resort: scan right side of viewport aggressively
    const viewW = window.innerWidth;
    const elements = [...document.querySelectorAll("div, section, aside, main, article, .CodeMirror, iframe")];
    
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // If element is on the right half of the screen
      if (rect.left > viewW * 0.45 && rect.width > 80 && rect.height > 100) {
        // If it's an iframe, we can't read it here (CORS), but the iframe's own script will catch it.
        if (el.tagName === "IFRAME") continue;
        
        const text = el.innerText?.trim();
        if (text && text.length > 80) return cleanStepText(text);
      }
    }
    return "";
  }

  function getCurrentStepText() {
    return getActiveStepInstruction() || getFullPanelText();
  }

  // ─── VM Canvas ──────────────────────────────────────────────────────────────
  function getVMCanvas() {
    return findFirst(VM_CANVAS_SELECTORS);
  }

  function focusVM() {
    const canvas = getVMCanvas();
    if (canvas) { canvas.click(); canvas.focus(); return true; }
    // If canvas is inside an iframe we can't directly focus, click the iframe area
    const iframe = document.querySelector("iframe");
    if (iframe) { iframe.focus(); return true; }
    return false;
  }

  function sendKeyToVM(key, modifiers = {}) {
    const canvas = getVMCanvas() || document.activeElement || document.body;
    const opts = {
      key, code: key, bubbles: true, cancelable: true,
      ctrlKey:  modifiers.ctrl  || false,
      altKey:   modifiers.alt   || false,
      shiftKey: modifiers.shift || false,
      metaKey:  modifiers.meta  || false
    };
    canvas.dispatchEvent(new KeyboardEvent("keydown",  opts));
    canvas.dispatchEvent(new KeyboardEvent("keypress", opts));
    canvas.dispatchEvent(new KeyboardEvent("keyup",    opts));
  }

  function parseShortcut(shortcut) {
    const parts = shortcut.toLowerCase().split("+");
    const mods = {
      ctrl:  parts.includes("ctrl")  || parts.includes("control"),
      alt:   parts.includes("alt"),
      shift: parts.includes("shift"),
      meta:  parts.includes("win")   || parts.includes("meta") || parts.includes("super")
    };
    const reserved = ["ctrl","control","alt","shift","win","meta","super"];
    const key = parts.find(p => !reserved.includes(p)) || parts[parts.length - 1];
    return { key, mods };
  }

  // ─── Text Injection ──────────────────────────────────────────────────────────
  // BUG-05 FIX: Use clipboard API for reliable text injection into the VM.
  // KeyboardEvents with isTrusted=false are ignored by remote desktop protocols.
  // Clipboard write + Ctrl+V is the universally reliable approach.
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback: use a hidden textarea + execCommand copy
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  // Primary method: use Cengage's Type Text dialog
  async function typeTextViaButton(text) {
    const btn = findFirst(TYPE_TEXT_BTN_SELECTORS);
    if (!btn || !isVisible(btn)) {
      sendStatus("Type Text button not found — using clipboard", "warn");
      return typeTextViaClipboard(text);
    }

    sendStatus(`Type Text: "${text.slice(0, 50)}"`, "info");
    btn.click();
    await delay(900);

    const input = await waitForEl(TYPE_TEXT_INPUT_SELECTORS, 4000);
    if (!input) {
      sendStatus("Type Text dialog did not open — using clipboard", "warn");
      return typeTextViaClipboard(text);
    }

    // Fill the dialog input
    input.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
    const setter = nativeSetter?.set;
    if (setter) setter.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input",  { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(300);

    // Click submit / press Enter
    const submitBtn = findFirst(TYPE_TEXT_SUBMIT_SELECTORS);
    if (submitBtn && isVisible(submitBtn)) {
      submitBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", bubbles: true }));
    }
    await delay(600);
    return true;
  }

  // BUG-05 FIX: Reliable clipboard-based text injection
  async function typeTextViaClipboard(text) {
    sendStatus(`Clipboard inject: "${text.slice(0, 50)}"`, "info");
    const copied = await copyToClipboard(text);
    if (!copied) {
      sendStatus("Clipboard copy failed — skipping injection", "error");
      return false;
    }
    // Focus VM then paste
    focusVM();
    await delay(300);
    sendKeyToVM("v", { ctrl: true });
    await delay(400);
    return true;
  }

  // ─── AI Integration ─────────────────────────────────────────────────────────
  function askAI(prompt) {
    return new Promise(resolve => {
      chrome.storage.sync.get(["apiKey"], ({ apiKey }) => {
        if (!apiKey) { resolve(""); return; }
        chrome.runtime.sendMessage({ type: "ASK_AI", prompt, apiKey }, resp => {
          if (chrome.runtime.lastError || !resp) { resolve(""); return; }
          if (resp.error) {
            sendStatus(`AI error: ${resp.error}`, "error");
            resolve("");
            return;
          }
          resolve(resp.text || "");
        });
      });
    });
  }

  function buildActionsPrompt(stepText, labContext) {
    return `You are an expert lab automation assistant for Windows Server, Windows 10, and Kali Linux VM labs.

Given the following lab step instruction, return a JSON array of keyboard/text actions to complete it.
IMPORTANT: Use keyboard-only actions — we cannot click arbitrary GUI elements.

Lab context: ${labContext}

Current step:
"""
${stepText}
"""

Action types available:
- {"type":"focus_vm"} — focus the VM window before typing
- {"type":"type_text","value":"text"} — type text into VM (uses clipboard paste). Use for: passwords, commands, form text, usernames
- {"type":"key","value":"Enter"} — single key press. Values: Enter, Tab, Escape, Space, F1-F12, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, Delete, Backspace
- {"type":"shortcut","value":"ctrl+v"} — keyboard shortcut. Examples: ctrl+c, ctrl+v, ctrl+a, ctrl+shift+esc, alt+tab, alt+f4
- {"type":"win_run","value":"notepad.exe"} — open Win+R Run dialog and run a command. Use for opening apps.
- {"type":"wait","value":2000} — wait N milliseconds. Always add after win_run and after app launches.

Common mappings:
- "Windows Defender Firewall with Advanced Security" → win_run "wf.msc"
- "Computer Management" → win_run "compmgmt.msc"
- "Server Manager" → win_run "ServerManager.exe"
- "Active Directory Users" → win_run "dsa.msc"
- "Group Policy Management" → win_run "gpmc.msc"
- "Registry Editor" → win_run "regedit.exe"
- "Command Prompt as admin" → win_run "cmd.exe" (then use keyboard to run as admin)
- "PowerShell" → win_run "powershell.exe"
- "Task Manager" → shortcut "ctrl+shift+esc"
- "Sign in / login" → type_text the password/username, then key Enter

Rules:
- Always start with focus_vm
- After win_run, always add wait 3000
- After app opens, add wait 2000 before interacting
- For multi-word app names, use the .msc or .exe form in win_run

Return ONLY the raw JSON array. No explanation, no markdown fences.
Example: [{"type":"focus_vm"},{"type":"type_text","value":"Pass!Word!"},{"type":"key","value":"Enter"},{"type":"wait","value":2000}]`;
  }

  // BUG-12 FIX: Retry once with simplified prompt if JSON parse fails
  async function getActionsForStep(stepText, labContext = "") {
    const raw = await askAI(buildActionsPrompt(stepText, labContext));
    if (!raw) return null;

    const cleaned = raw.replace(/^```[\w]*\r?\n?/, "").replace(/\r?\n?```\s*$/, "").trim();

    try {
      const actions = JSON.parse(cleaned);
      if (Array.isArray(actions) && actions.length > 0) return actions;
    } catch (_) {
      sendStatus("AI response was not valid JSON — retrying with simplified prompt...", "warn");
    }

    // BUG-12 FIX: Retry with a simpler prompt
    const retryPrompt = `Given this lab step, return ONLY a JSON array of actions. No explanation.
Step: "${stepText.slice(0, 300)}"
Reply format: [{"type":"focus_vm"},{"type":"type_text","value":"..."},{"type":"key","value":"Enter"}]`;
    const retryRaw = await askAI(retryPrompt);
    if (!retryRaw) return null;
    const retryCleaned = retryRaw.replace(/^```[\w]*\r?\n?/, "").replace(/\r?\n?```\s*$/, "").trim();
    try {
      const actions = JSON.parse(retryCleaned);
      if (Array.isArray(actions)) return actions;
    } catch (_) {
      sendStatus("Retry also failed — skipping step", "error");
    }
    return null;
  }

  // ─── Execute Actions ────────────────────────────────────────────────────────
  async function executeAction(action) {
    if (stopRequested) return;
    switch (action.type) {
      case "focus_vm":
        sendStatus("Focusing VM", "info");
        focusVM();
        await delay(400);
        break;

      case "type_text":
        await typeTextViaButton(String(action.value || ""));
        await delay(currentSpeed * 0.3);
        break;

      case "key":
        sendStatus(`Key: ${action.value}`, "info");
        focusVM();
        await delay(200);
        sendKeyToVM(String(action.value));
        await delay(currentSpeed * 0.2);
        break;

      case "shortcut": {
        sendStatus(`Shortcut: ${action.value}`, "info");
        focusVM();
        await delay(200);
        const { key, mods } = parseShortcut(String(action.value));
        sendKeyToVM(key, mods);
        await delay(currentSpeed * 0.3);
        break;
      }

      // BUG-06 FIX: win_run uses clipboard for the command, not the Type Text button
      // Avoids the issue of Cengage's Type Text dialog stealing focus from the Run dialog
      case "win_run": {
        const cmd = String(action.value || "");
        sendStatus(`Win+R → ${cmd}`, "info");
        focusVM();
        await delay(300);
        // Open Run dialog
        sendKeyToVM("r", { meta: true });
        await delay(1500); // Wait for Run dialog to appear
        // Copy command to clipboard and paste
        await copyToClipboard(cmd);
        await delay(200);
        sendKeyToVM("a", { ctrl: true }); // Select all in Run box
        await delay(100);
        sendKeyToVM("v", { ctrl: true }); // Paste
        await delay(400);
        sendKeyToVM("Enter");
        await delay(action.waitAfter || 3000);
        break;
      }

      case "wait":
        sendStatus(`Waiting ${action.value}ms`, "info");
        await delay(Number(action.value) || 1000);
        break;

      default:
        sendStatus(`Unknown action: ${action.type}`, "warn");
    }
  }

  async function executeActionsLocally(actions) {
    if (!actions?.length) return;
    sendStatus(`Executing ${actions.length} action(s)...`, "info");
    for (const action of actions) {
      if (stopRequested) break;
      await executeAction(action);
    }
  }

  // ─── Cross-Frame Execution ──────────────────────────────────────────────────
  function dispatchActions(actions) {
    if (!actions || actions.length === 0) return;
    // We send to background, which broadcasts to ALL frames in the active tab
    // So the frame holding the VM canvas will catch it and execute
    chrome.runtime.sendMessage({ type: "VM_ACTION", actions });
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────
  async function clickNext() {
    await delay(currentSpeed * 0.4);
    for (const sel of NEXT_BTN_SELECTORS) {
      try {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled && isVisible(btn)) {
          sendStatus(`Clicking Next: "${btn.innerText?.trim().slice(0,30) || btn.className}"`, "info");
          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          await delay(300);
          btn.click();
          await delay(currentSpeed);
          return true;
        }
      } catch (_) {}
    }
    // Text scan fallback
    const allBtns = [...document.querySelectorAll("button, [role='button'], a")];
    for (const btn of allBtns) {
      const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim().toLowerCase();
      if ((text === "next" || text === "continue" || text === "next step") && isVisible(btn)) {
        sendStatus(`Clicking Next (text): "${text}"`, "info");
        btn.click();
        await delay(currentSpeed);
        return true;
      }
    }
    sendStatus("Next button not found", "warn");
    return false;
  }

  function isLabComplete() {
    const keywords = [
      "lab complete", "activity complete", "assignment complete",
      "you have completed", "congratulations", "great job",
      "score:", "you scored", "lab finished", "well done",
      "0 minutes remaining", "time expired"
    ];
    const body = document.body.innerText.toLowerCase();
    return keywords.some(kw => body.includes(kw));
  }

  function detectLabContext() {
    const text = (document.title + " " + document.body.innerText.slice(0, 600)).toLowerCase();
    if (text.includes("kali")) return "Kali Linux";
    if (text.includes("ubuntu") || text.includes("debian")) return "Ubuntu Linux";
    if (text.includes("server 2022")) return "Windows Server 2022";
    if (text.includes("server 2019")) return "Windows Server 2019";
    if (text.includes("server 2016")) return "Windows Server 2016";
    if (text.includes("windows 10") || text.includes("windows 11")) return "Windows 10/11";
    if (text.includes("cisco") || text.includes("router") || text.includes("switch")) return "Cisco networking lab";
    if (text.includes("active directory") || text.includes("domain controller")) return "Windows Server Active Directory lab";
    if (text.includes("firewall") || text.includes("defender")) return "Windows Server with Windows Defender Firewall";
    if (text.includes("iis") || text.includes("web server")) return "Windows Server IIS Web Server lab";
    return "Windows Server lab";
  }

  // ─── Master Loop ─────────────────────────────────────────────────────────────
  async function runVMLab() {
    if (isRunning) { sendStatus("Already running.", "warn"); return; }
    isRunning = true;
    stopRequested = false;
    sendStatus("🖥️ VM Lab automation starting...", "info");
    await delay(currentSpeed);

    const labContext = detectLabContext();
    sendStatus(`Lab context detected: ${labContext}`, "info");

    let stepCount = 0;
    const MAX_STEPS = 80;
    let lastStepText = "";
    let sameStepCount = 0;

    while (isRunning && !stopRequested && stepCount < MAX_STEPS) {
      stepCount++;
      if (isLabComplete()) { sendStatus("🎉 Lab complete!", "success"); break; }

      const stepText = getCurrentStepText();
      
      // If we found NO instructions, this frame might just be the canvas frame.
      // We shouldn't spam "No instruction found" unless we were previously finding them.
      if (!stepText) {
        if (stepCount === 1) {
           // We are not the master frame (likely the canvas frame). Just wait.
           // We will act when we receive VM_ACTION messages.
           sendStatus("Acting as Canvas node (no instructions found here)", "info");
           return; 
        }
        sendStatus("No step instruction found — waiting...", "warn");
        await delay(3000);
        sameStepCount++;
        if (sameStepCount >= 4) { sendStatus("No instructions found — stopping.", "error"); break; }
        continue;
      }

      sameStepCount = 0;

      if (stepText === lastStepText) {
        sameStepCount++;
        if (sameStepCount >= 4) {
          sendStatus("Step stuck after 4 attempts — trying Next anyway.", "warn");
          const advanced = await clickNext();
          if (!advanced) { sendStatus("Cannot advance — stopping.", "error"); break; }
          sameStepCount = 0;
          await delay(currentSpeed);
          continue;
        }
        sendStatus(`Step unchanged (${sameStepCount}/4) — waiting...`, "warn");
        await delay(currentSpeed);
        continue;
      }

      sameStepCount = 0;
      lastStepText = stepText;
      sendStatus(`Step ${stepCount}: "${stepText.slice(0, 90)}..."`, "info");

      sendStatus("Asking AI for actions...", "info");
      const actions = await getActionsForStep(stepText, labContext);
      if (stopRequested) break;

      if (!actions || actions.length === 0) {
        sendStatus("AI returned no actions — advancing to next step.", "warn");
      } else {
        // Dispatch actions to all frames (including ourselves if we have the canvas)
        dispatchActions(actions);
        // We calculate total wait time roughly so the master loop doesn't click next too early
        const totalWait = actions.reduce((acc, a) => {
           if (a.type === 'wait') return acc + Number(a.value || 1000);
           if (a.type === 'win_run') return acc + 2500 + Number(a.waitAfter || 3000);
           if (a.type === 'type_text') return acc + 1000 + currentSpeed * 0.3;
           return acc + 600;
        }, 0);
        await delay(totalWait + 1000);
        if (stopRequested) break;
        await delay(currentSpeed * 0.5);
      }

      await clickNext();
      await delay(currentSpeed);
    }

    if (stepCount >= MAX_STEPS) sendStatus("Max steps reached.", "warn");
    isRunning = false;
    sendStatus("VM lab automation ended.", "info");
  }

  async function stepOnceVM() {
    const labContext = detectLabContext();
    const stepText = getCurrentStepText();
    if (!stepText) { 
        // Silent if canvas node
        return; 
    }
    sendStatus(`Single step: "${stepText.slice(0, 90)}"`, "info");
    const actions = await getActionsForStep(stepText, labContext);
    if (actions?.length) {
      dispatchActions(actions);
    } else {
      sendStatus("AI returned no actions for this step.", "warn");
    }
  }

  // ─── Message Handler ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_VM_LAB") {
      currentSpeed = speedToMs(msg.speed || 2);
      runVMLab();
      sendResponse({ ok: true });
    }
    if (msg.type === "STOP_AUTOMATION") {
      stopRequested = true;
      isRunning = false;
      sendStatus("VM lab stopped by user.", "warn");
      sendResponse({ ok: true });
    }
    if (msg.type === "STEP_ONCE_VM") {
      currentSpeed = speedToMs(msg.speed || 2);
      stepOnceVM();
      sendResponse({ ok: true });
    }
    if (msg.type === "VM_ACTION") {
      // If we receive this message, check if we have the VM canvas.
      // Only the frame with the VM canvas should execute keyboard/paste actions.
      if (getVMCanvas() || document.querySelector("iframe")) {
         executeActionsLocally(msg.actions);
      }
    }
    if (msg.type === "PING") {
      sendResponse({ alive: true, mode: "vm-lab" });
    }
    return true;
  });

  sendStatus("🖥️ VM Lab Automator loaded. Open the extension popup to start.", "info");

})();
