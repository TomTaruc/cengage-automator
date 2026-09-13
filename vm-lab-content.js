// =============================================================================
// Cengage VM Lab Automator — vm-lab-content.js  v3.0
// Runs on labclient.labondemand.com (Lab on Demand / Cengage virtual labs).
//
// Architecture (v3.0 — Full Persona Agent):
//   Phase 0 – "Read the Entire Task First"
//     • Scrapes ALL right-side instruction text (every step, sub-step, note).
//     • Sends the full task to AI to produce a numbered checklist.
//   Phase 1 – Per-step visual verification loop
//     • Screenshots the VM → sends step text + screenshot → AI returns JSON.
//     • JSON includes: thought, checklist update, actions[], status, error_reason.
//     • Executes actions in the VM, waits, re-screenshots to verify.
//     • On error: AI is shown the error screenshot and asked to diagnose & fix.
//     • Loop continues (up to MAX_ITERATIONS) until AI says "complete".
//   Phase 2 – After each step
//     • Clicks "Verify" if present; checks result.
//     • Advances to next step only after verification passes.
//   Phase 3 – Pre-submission review
//     • Re-reads all instructions, asks AI if anything was missed.
//     • Only then allows submit / lab-complete.
// =============================================================================

(function () {
  "use strict";

  // ─── Frame Guard ────────────────────────────────────────────────────────────
  // The key insight: LOD pages load the VM canvas in the top frame and the
  // instructions in a CROSS-ORIGIN sub-iframe. Both frames run this script.
  // The old blind race let the top/VM frame win master — but it has no instructions.
  //
  // Fix: master election is CAPABILITY-BASED.
  //   • A frame that can find instruction text → "instructions-capable" (priority 2)
  //   • A frame that can find the VM canvas    → "canvas-capable" (priority 1)
  //   • A frame that has neither               → "unknown" (priority 0)
  //
  // The highest-priority frame wins master.  Canvas frames become VM executors.
  // If two frames have equal priority we fall back to the storage race.
  let IS_MASTER_FRAME = false;
  let IS_CANVAS_FRAME = false; // set after capability probe

  function probeCapability() {
    // Check for instructions
    const hasInstructions = !!(
      document.querySelector("#instructionsContent") ||
      document.querySelector("#pages") ||
      document.querySelector(".task-list-item") ||
      document.querySelector(".lab-instructions") ||
      document.querySelector(".instructions-content") ||
      document.querySelector("[class*='instruction']") ||
      document.querySelector("[class*='step-content']") ||
      document.querySelector("[class*='task-content']")
    );
    // If no known selector matched, check for substantial text on the right side
    let hasInstructionText = hasInstructions;
    if (!hasInstructionText) {
      const viewW = window.innerWidth;
      const candidates = [...document.querySelectorAll("div, section, aside, article")];
      for (const el of candidates) {
        try {
          const rect = el.getBoundingClientRect();
          const text = el.innerText?.trim() || "";
          if (rect.left > viewW * 0.35 && text.length > 80 &&
              /\b(step|task|configure|install|open|click|enter|run|verify|enable|create|navigate|command|type)\b/i.test(text)) {
            hasInstructionText = true;
            break;
          }
        } catch (_) {}
      }
    }

    // Check for VM canvas
    const hasCanvas = !!(
      document.querySelector("canvas") ||
      document.querySelector("iframe[id*='vm']") ||
      document.querySelector("iframe[src*='vm']") ||
      document.querySelector("[class*='vm-screen']") ||
      document.querySelector("[class*='remote-display']")
    );

    IS_CANVAS_FRAME = hasCanvas && !hasInstructionText;

    if (hasInstructionText) return 2;   // instructions frame — should be master
    if (hasCanvas) return 1;            // VM/canvas frame — executor
    return 0;                           // unknown
  }

  function tryAcquireMasterLock() {
    return new Promise(resolve => {
      if (!chrome.storage || !chrome.storage.local) {
        resolve(false);
        return;
      }

      const priority = probeCapability();
      const myToken = `${Date.now()}-P${priority}-${Math.random().toString(36).slice(2)}`;

      // Write our token with priority embedded
      chrome.storage.local.set({ vmMasterFrame: myToken, vmMasterPriority: priority }, () => {
        // Wait for race window — higher-priority frames will overwrite lower ones
        setTimeout(() => {
          chrome.storage.local.get(["vmMasterFrame", "vmMasterPriority"], (data) => {
            const currentToken = data.vmMasterFrame;
            const currentPriority = data.vmMasterPriority || 0;

            // If a higher-priority frame already claimed it, yield
            if (currentPriority > priority) {
              resolve(false);
              return;
            }

            // If same priority, use token equality (first writer wins among equals)
            if (currentToken === myToken) {
              resolve(true);
              return;
            }

            // Another frame of equal or higher priority won
            resolve(false);
          });
        }, 100 + Math.random() * 150); // 100-250ms race window
      });
    }).catch(e => {
      console.error("[VM-Automator] Lock error:", e);
      return false;
    });
  }

  function releaseMasterLock() {
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(["vmMasterFrame", "vmMasterPriority"]);
    }
  }

  // ─── State ─────────────────────────────────────────────────────────────────
  let isRunning      = false;
  let stopRequested  = false;
  let currentSpeed   = 1500;
  let globalChecklist = [];   // persists across steps
  let fullTaskText    = "";   // cached full task (Phase 0)

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
      case 3: return 400;   // Fast
      case 2: return 1000;  // Medium
      default: return 2000; // Slow
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

  // ─── Selectors ───────────────────────────────────────────────────────────────

  // LOD (labclient.labondemand.com) real IDs discovered by DOM inspection:
  //   #instructionsContent  — outer panel that holds all instruction HTML
  //   #pages .page.selected — currently visible step
  //   #pages .page          — any step (fallback)
  //   .task-list-item       — individual task items
  // Also include common Cengage/MindTap class names as fallback.
  const STEP_TEXT_SELECTORS = [
    // ── LOD / Skillable real selectors ──────────────────────────────────────
    "#instructionsContent",
    "#pages .page.selected",
    "#pages .page",
    ".task-list-item",
    "#instructions-content",
    // ── Generic Cengage / MindTap selectors ─────────────────────────────────
    ".instructions-content",
    ".lab-instructions",
    "#instructions-tab-content",
    ".lod-instructions",
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
    // LOD real selectors
    "#pages .page.selected",
    "#pages .page:not(.hidden)",
    ".page.selected",
    // Generic
    "[class*='active'][class*='step']",
    "[class*='current'][class*='step']",
    "[class*='step'].active",
    "[aria-current='step']",
    "[class*='step-active']",
    "li.active",
    ".current-step",
    "[class*='active-task']"
  ];

  // LOD uses id="next" and id="previous" for navigation buttons
  const NEXT_BTN_SELECTORS = [
    "#next",
    "#nextButton",
    "button[class*='next']",
    "[class*='next-btn']",
    "[class*='btn-next']",
    "button[aria-label='Next']",
    "button[title='Next']",
    ".next-step",
    "[data-action='next']",
    "[class*='step-next']",
    ".lod-next-button",
    "button.btn-primary"
  ];

  // VM remote desktop canvas or display element (LOD uses a plain <canvas>)
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
  const NOISE_PATTERNS = [
    /hints?\s+enabled/gi,
    /\d+\s+minutes?\s+remaining/gi,
    /\d+:\d+\s+remaining/gi,
    /instructions?\s+resources?/gi,
    /previous\s+next/gi,
    /show\s+hints?/gi,
    /expand\s+this\s+hint/gi,
    /^resources?\s*$/gim,
    /^instructions?\s*$/gim,
    // Strip keyboard shortcut rows that appear in the VM toolbar
    /Esc\s+F1\s+F2\s+F3[\s\S]*?F12/gi,
    /^(Esc|F\d+|Tab|Caps|Shift|Ctrl|Alt|Win|Print|Scroll|Pause|Insert|Delete|Home|End|Page)\s*/gim,
    // Strip UI control labels
    /\b(Type Text|Send Text|Copy|Paste|Lightning Bolt|Fit Screen|Full Screen)\b/gi,
  ];

  // Returns true if the text looks like real instructions (not keyboard chrome)
  function looksLikeInstructions(text) {
    if (!text || text.length < 60) return false;
    // Must contain at least one sentence-like word found in lab instructions
    const TASK_SIGNAL = /\b(step|task|configure|install|open|click|enter|type|run|execute|verify|enable|disable|create|delete|navigate|command|server|firewall|network|password|account|address|policy|service|script|check|display|window|apply|add|remove|select|right.click)\b/i;
    return TASK_SIGNAL.test(text);
  }

  function cleanStepText(raw) {
    if (!raw) return "";
    let text = raw;
    for (const pattern of NOISE_PATTERNS) {
      text = text.replace(pattern, "");
    }
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ─── Read Instructions ──────────────────────────────────────────────────────

  function getActiveStepInstruction() {
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
    // 1. Try known selectors (LOD first, then generic Cengage)
    for (const sel of STEP_TEXT_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText?.trim().length > 20) {
          return cleanStepText(el.innerText.trim());
        }
      } catch (_) {}
    }

    // 2. Scan right side of viewport — LOD puts instructions in right ~20% of screen
    const viewW = window.innerWidth;
    const elements = [...document.querySelectorAll("div, section, aside, main, article")];
    // Sort by left position so we pick the rightmost substantial element
    const rightCandidates = elements
      .map(el => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left > viewW * 0.4 && rect.width > 60 && rect.height > 100)
      .sort((a, b) => b.rect.left - a.rect.left);
    for (const { el } of rightCandidates) {
      const text = el.innerText?.trim();
      if (text && text.length > 80) return cleanStepText(text);
    }
    return "";
  }

  /**
   * Attempt to read ALL instructions visible in the panel, not just the current step.
   * Used for Phase 0 (read-entire-task-first).
   */
  function getAllInstructionsText() {
    // 1. Try known instruction-panel selectors first
    for (const sel of STEP_TEXT_SELECTORS) {
      try {
        const el = document.querySelector(sel);
        if (el && el.innerText?.trim().length > 50) {
          return cleanStepText(el.innerText.trim()).slice(0, 8000);
        }
      } catch (_) {}
    }

    // 2. Scan all block elements for anything that looks like instructions
    //    (contains numbered steps, task words, or substantial prose)
    const TASK_WORDS = /\b(step|task|configure|install|open|click|enter|type|run|execute|verify|enable|disable|create|delete|navigate|right.click|command|terminal|server|network|firewall|policy|account|password|address|port)\b/i;
    const candidates = [...document.querySelectorAll("div, section, article, main, aside, li, p")];
    let best = "";
    for (const el of candidates) {
      try {
        const t = el.innerText?.trim();
        if (t && t.length > 100 && t.length > best.length && TASK_WORDS.test(t)) {
          // Prefer elements that aren't the entire body (avoid pulling in nav/chrome)
          if (el !== document.body && el.querySelectorAll("*").length < 300) {
            best = t;
          }
        }
      } catch (_) {}
    }
    if (best) return cleanStepText(best).slice(0, 8000);

    // 3. Absolute fallback — entire body text
    const body = document.body?.innerText?.trim() || "";
    return cleanStepText(body).slice(0, 8000);
  }

  function getCurrentStepText() {
    const candidates = [
      getActiveStepInstruction(),
      getFullPanelText(),
      getAllInstructionsText()
    ];
    for (const text of candidates) {
      if (text && looksLikeInstructions(text)) return text;
    }
    return null; // Nothing found that looks like real instructions
  }

  // ─── VM Canvas ──────────────────────────────────────────────────────────────
  function getVMCanvas() {
    return findFirst(VM_CANVAS_SELECTORS);
  }

  function focusVM() {
    const canvas = getVMCanvas();
    if (canvas) { canvas.click(); canvas.focus(); return true; }
    const iframe = document.querySelector("iframe");
    if (iframe) { iframe.focus(); return true; }
    return false;
  }

  function sendNativeKey(key, modifiers = 0, textStr = "") {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: "NATIVE_KEY", key, modifiers, text: textStr
      }, () => resolve());
    });
  }

  function parseShortcut(shortcut) {
    const parts = shortcut.toLowerCase().split("+");
    // modifiers bitfield: Alt=1, Ctrl=2, Meta=4, Shift=8
    let mods = 0;
    if (parts.includes("alt")) mods |= 1;
    if (parts.includes("ctrl") || parts.includes("control")) mods |= 2;
    if (parts.includes("meta") || parts.includes("win") || parts.includes("super")) mods |= 4;
    if (parts.includes("shift")) mods |= 8;

    const reserved = ["ctrl","control","alt","shift","win","meta","super"];
    const key = parts.find(p => !reserved.includes(p)) || parts[parts.length - 1];
    return { key, mods };
  }

  // ─── Text Injection ──────────────────────────────────────────────────────────
  async function typeTextNatively(text) {
  async function typeTextNatively(text) {
    sendStatus(`Native typing: "${text.slice(0, 60)}"`, "info");
    focusVM();
    await delay(200);
    for (const char of text) {
      if (stopRequested) break;
      if (char === "\n" || char === "\r") {
        await sendNativeKey("Enter", 0, "");
      } else {
        await sendNativeKey(char, 0, char);
      }
      await delay(18); // 18ms per char — slightly slower for reliability
    }
    return true;
  }

  // ─── AI Integration ─────────────────────────────────────────────────────────
  function askAI(prompt, imageBase64 = null) {
    return new Promise(resolve => {
      chrome.storage.sync.get(["apiKey", "openaiKey", "openrouterKey", "provider", "model"], (data) => {
        const provider = data.provider || "gemini";
        const model = data.model || null;
        // Pick the right API key for the selected provider
        let apiKey = data.apiKey || "";
        if (provider === "openai") apiKey = data.openaiKey || data.apiKey || "";
        if (provider === "openrouter") apiKey = data.openrouterKey || data.apiKey || "";

        if (!apiKey) { resolve(""); return; }
        chrome.runtime.sendMessage(
          { type: "ASK_AI", prompt, apiKey, imageBase64, provider, model },
          resp => {
            if (chrome.runtime.lastError || !resp) { resolve(""); return; }
            if (resp.error) {
              sendStatus(`AI error: ${resp.error}`, "error");
              resolve("");
              return;
            }
            resolve(resp.text || "");
          }
        );
      });
    });
  }

  function getScreenshot() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: "CAPTURE_SCREEN" }, resp => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          resolve(null);
        } else {
          resolve(resp.imageBase64);
        }
      });
    });
  }

  function stripJSON(raw) {
    if (!raw) return "";
    return raw.replace(/^```[\w]*\r?\n?/, "").replace(/\r?\n?```\s*$/, "").trim();
  }

  // ─── Shared Persona (injected into every AI prompt) ─────────────────────────
  const AGENT_PERSONA = `
## Core Rules — Non-Negotiable

### 1. Read the Entire Task First
Before performing any action:
- Read ALL instructions on the right side — every numbered step, sub-step, command, script, config, test, and verification.
- Identify which environment each step targets: Kali Linux, Windows, Browser, Network device, or other VM.
- Note every exact value (IP addresses, ports, usernames, passwords, file paths, URLs, interface names, case-sensitive strings).
- Create an internal checklist. Do not skip a step because the result looks obvious.

### 2. Execute Instead of Explaining
For every instruction that requires an action:
  Open application → Navigate → Enter command → Execute → Wait → Observe output → Verify expected result → Continue.
NEVER respond with "Run this command." — actually run it. Do NOT mark complete until you have seen the expected result on screen.

### 3. Kali Linux Tasks
1. Open the required terminal/application.
2. Navigate to the correct directory.
3. Execute every required command exactly.
4. If a script is provided, run it exactly as required.
5. Observe stdout/stderr and exit status.
6. Check whether files were created or modified.
7. Verify network connectivity, services, and processes when applicable.
Verification commands (use only when appropriate):
  echo $?  |  ls -la  |  pwd  |  ip addr  |  ip route  |  ps aux  |  ss -tulpn

### 4. Windows Tasks
1. Open the specified application.
2. Navigate through the required interface.
3. Enter commands into CMD or PowerShell when instructed.
4. Execute scripts when required.
5. Verify the resulting configuration or output.
Verification commands (use only when appropriate):
  ipconfig /all  |  Get-Service  |  Get-Process  |  Get-ChildItem  |  Get-Location

### 5. Scripts
1. Locate the script.
2. Understand its intent.
3. Check the current directory.
4. Execute it using the method specified by the lab.
5. Wait for completion.
6. Check exit status, inspect output, verify changes.
7. If execution fails: diagnose → fix → re-run → verify.
Never assume a script succeeded because no obvious error appeared.

### 6. Every Command: Execute → Observe → Verify → Continue
If a command returns an error:
1. Read the error.
2. Identify the cause: wrong directory, wrong syntax, missing package, service not running, network config, permission, wrong target, previous step not done.
3. Fix the issue.
4. Re-execute the original command.
5. Verify the expected result.
Do NOT repeat a failing command without diagnosing why it failed.

### 7. GUI Instructions
- Click the exact element specified.
- Enter the required values exactly.
- Save/apply the configuration.
- Confirm the setting was actually applied.
Pay attention to: IP addresses, hostnames, ports, usernames, file paths, URLs, interface names, service names, config values, case sensitivity.

### 8. Do Not Skip "Small" Steps
These must NEVER be skipped: cd, mkdir, file creation, file editing, file saving, starting/stopping services, setting permissions, running scripts, running scans, checking results, opening applications, selecting targets, applying configurations, confirming dialogs.

### 9. Checklist Discipline
A step only gets [✓] when its result has been visually verified in a screenshot.
[✓] = verified  |  [ ] = not complete

### 10. Handle Errors Properly
FAILED → Read error → Identify cause → Check environment → Correct issue → Re-run → Verify → Continue.
Do not abandon steps on first failure.

### 11. Avoid Unnecessary Changes
Only make changes required by the instructions or necessary to resolve an error in the lab.

### 12. Security Lab Restrictions
Perform security commands ONLY against targets explicitly provided by the MindTap exercise. Do NOT extend scans, attacks, or exploitation to systems outside the assigned lab environment.

### 13. Verification Before Submission
Before completing: check every command, script, configuration, required file, scan, value, output, and question against the full instructions list.

### 14. Do Not Submit Prematurely
NEVER mark complete just because the main task appears to work. Ask internally: "Have I completed every instruction including sub-steps and verification?"

### 15. Final State
Only mark COMPLETE when: all instructions performed, commands executed, scripts executed, configurations applied, results verified, errors resolved, and the instruction list double-checked.
`;

  // ─── Phase 0 Prompt: Read the Entire Task First ──────────────────────────────
  function buildReadTaskPrompt(allInstructions, labContext) {
    return `You are an automation agent for Cengage MindTap virtual cybersecurity labs (${labContext}).
${AGENT_PERSONA}
## PHASE 0 — READ THE ENTIRE TASK FIRST

Full lab instructions:
"""
${allInstructions}
"""

Return ONLY a valid JSON object. Do NOT use markdown fences.
{
  "summary": "One-sentence description of what this lab does",
  "context": "Kali Linux | Windows Server 2022 | Windows 10 | Mixed | etc.",
  "checklist": [
    "[ ] Step 1: description",
    "[ ] Step 2: description"
  ],
  "critical_values": {
    "note": "Any exact IP addresses, passwords, file paths, commands from the instructions"
  },
  "first_actions": [
    {"type":"focus_vm"},
    {"type":"type_text","value":"ls -la"}
  ]
}`;
  }

  // ─── Per-Step Agent Prompt ───────────────────────────────────────────────────
  function buildStepPrompt(stepText, labContext, checklist, previousErrorReason) {
    const errorSection = previousErrorReason
      ? `\n## Previous Attempt Failed\nError reason from last iteration: "${previousErrorReason}"\nYou must diagnose why that failed and take a DIFFERENT action to resolve it before retrying.\n`
      : "";

    const checklistText = checklist.length > 0
      ? checklist.join("\n")
      : "(No checklist yet — this may be the first step)";

    return `You are an automation agent for Cengage MindTap virtual cybersecurity labs (${labContext}).
${AGENT_PERSONA}
${errorSection}
---

Lab context: ${labContext}

Current step instructions:
"""
${stepText}
"""

Current checklist state:
${checklistText}

A screenshot of the current VM state is attached. Analyze it carefully before deciding what to do.

## Available Actions
- {"type":"focus_vm"} — focus the VM window before typing (always first)
- {"type":"type_text","value":"text"} — type text via native keystrokes. NEVER add a trailing space. Use \\n only for Enter within multi-line text.
- {"type":"clear_field"} — select all + delete in the currently focused field (use BEFORE typing into a field that already has content)
- {"type":"paste_text","value":"multi-line text"} — clipboard paste via Ctrl+V (best for long commands or scripts with special chars)
- {"type":"key","value":"Enter"} — single key: Enter, Tab, Escape, Space, Backspace, Delete, F1-F12, ArrowUp/Down/Left/Right, Home, End
- {"type":"shortcut","value":"ctrl+c"} — keyboard shortcut
- {"type":"win_run","value":"cmd.exe","waitAfter":3000} — Win+R run dialog
- {"type":"wait","value":2000} — wait N ms (always add after win_run and slow operations)
- {"type":"click","selector":".css-selector"} — click a DOM element in the Cengage instructions panel (NOT the VM canvas)
- {"type":"scroll","direction":"down","amount":300} — scroll the instructions panel

## Windows Login Screen (CRITICAL)
When you see the Windows lock/login screen:
1. First send: {"type":"shortcut","value":"ctrl+alt+delete"} then {"type":"wait","value":1500}
2. The password field will appear. Click it or Tab to it.
3. If a username field is present and already has the wrong user, use clear_field first, then type_text the correct username WITHOUT a trailing space.
4. Tab to the password field (or click it).
5. Use clear_field to clear any existing password.
6. type_text the password EXACTLY — NO trailing space, NO extra Enter in the value itself.
7. Then send {"type":"key","value":"Enter"} as a SEPARATE action.
8. Wait 3000ms for the desktop to load.

## Common Windows Shortcuts
- Windows Defender Firewall → win_run "wf.msc"
- Computer Management → win_run "compmgmt.msc"
- Server Manager → win_run "ServerManager.exe"
- Active Directory Users → win_run "dsa.msc"
- Group Policy Management → win_run "gpmc.msc"
- Registry Editor → win_run "regedit.exe"
- Command Prompt (admin) → shortcut "win+x" then type_text "a"
- PowerShell → win_run "powershell.exe"
- Task Manager → shortcut "ctrl+shift+esc"

## Action Sequencing Rules
- Always start actions with focus_vm
- NEVER include a trailing space in type_text values — passwords and usernames must be exact
- After win_run, always add wait 3000+
- After app opens, add wait 2000 before interacting
- After typing a command in terminal: add {"type":"key","value":"Enter"} as its own action, then {"type":"wait","value":2000}
- After waiting, the NEXT iteration screenshots to verify the result

Return ONLY a valid JSON object. Do NOT use markdown fences.
{
  "thought": "Detailed analysis of the screenshot and reasoning for next actions",
  "checklist": ["[✓] Step X: verified description", "[ ] Step Y: pending"],
  "actions": [
    {"type":"focus_vm"},
    {"type":"type_text","value":"ls -la"},
    {"type":"key","value":"Enter"},
    {"type":"wait","value":2000}
  ],
  "status": "in_progress",
  "error_reason": "",
  "report": ""
}

Status values:
- "in_progress" — still working, loop will re-screenshot and come back
- "verify_only" — no new actions needed, just screenshot to see result of previous actions
- "complete" — step fully done AND verified by observing expected output in the screenshot
- "error" — unrecoverable error (explain in error_reason)`;
  }

  // ─── Phase 3 Pre-Submission Review Prompt ──────────────────────────────────
  function buildPreSubmitPrompt(allInstructions, finalChecklist, labContext) {
    return `You are an automation agent completing a final pre-submission review of a Cengage MindTap cybersecurity lab (${labContext}).
${AGENT_PERSONA}
## PHASE 3 — VERIFICATION BEFORE SUBMISSION

Compare what was accomplished against EVERY instruction. Do NOT submit prematurely.

Full lab instructions:
"""
${allInstructions}
"""

Final checklist state:
${finalChecklist.join("\n")}

A screenshot of the current VM state is attached.

Check ALL of the following:
- Every command executed and verified
- Every script executed and verified
- Every configuration completed
- Every required file created/modified
- Every required scan/test performed
- Every required value entered correctly
- Every required output obtained
- All questions/tasks completed

Return ONLY a valid JSON object. Do NOT use markdown fences.
{
  "lab_status": "COMPLETE or PARTIALLY_COMPLETE",
  "completed_items": ["Item 1", "Item 2"],
  "verified_items": ["Command results", "Configuration"],
  "remaining_items": ["None" or list of incomplete items],
  "safe_to_submit": true,
  "final_report": "LAB STATUS: COMPLETE\\n\\nCompleted:\\n- Step 1\\n- Step 2\\n\\nVerified:\\n- Results\\n\\nRemaining:\\n- None"
}`;
  }

  // ─── Action Executor ─────────────────────────────────────────────────────────
  async function executeAction(action) {
    if (stopRequested) return;
    switch (action.type) {
      case "focus_vm":
        sendStatus("Focusing VM", "info");
        focusVM();
        await delay(250);
        break;

      case "type_text":
        // Strip trailing spaces — the AI sometimes appends them accidentally
        // (e.g. "Passw0rd! " instead of "Passw0rd!"). This is almost never intentional.
        await typeTextNatively(String(action.value || "").replace(/\s+$/, ""));
        await delay(currentSpeed * 0.2);
        break;

      case "clear_field":
        // Select all then delete — clears the currently focused field in the VM
        sendStatus("Clearing field (Ctrl+A, Delete)", "info");
        focusVM();
        await delay(100);
        await sendNativeKey("a", 2); // Ctrl+A
        await delay(150);
        await sendNativeKey("Delete", 0, "");
        await delay(200);
        break;

      case "key":
        sendStatus(`Key: ${action.value}`, "info");
        focusVM();
        await delay(100);
        await sendNativeKey(String(action.value));
        await delay(currentSpeed * 0.15);
        break;

      case "shortcut": {
        sendStatus(`Shortcut: ${action.value}`, "info");
        focusVM();
        await delay(100);
        const { key, mods } = parseShortcut(String(action.value));
        await sendNativeKey(key, mods);
        await delay(currentSpeed * 0.2);
        break;
      }

      case "win_run": {
        const cmd = String(action.value || "");
        sendStatus(`Win+R → ${cmd}`, "info");
        focusVM();
        await delay(200);
        await sendNativeKey("r", 4); // Win+R (Meta=4)
        await delay(1000);
        await typeTextNatively(cmd);
        await delay(200);
        await sendNativeKey("Enter");
        await delay(action.waitAfter || 2500);
        break;
      }

      case "wait":
        sendStatus(`Waiting ${action.value}ms`, "info");
        await delay(Number(action.value) || 1000);
        break;

      case "click": {
        // Click a DOM element in the instructions panel (not the VM)
        // action.selector: CSS selector string
        const sel = String(action.selector || action.value || "");
        if (!sel) { sendStatus("click action missing selector", "warn"); break; }
        try {
          const el = document.querySelector(sel);
          if (el && isVisible(el)) {
            sendStatus(`Clicking: ${sel}`, "info");
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            await delay(200);
            el.click();
            await delay(500);
          } else {
            sendStatus(`Click target not found or hidden: ${sel}`, "warn");
          }
        } catch (e) {
          sendStatus(`Click error: ${e.message}`, "warn");
        }
        break;
      }

      case "scroll": {
        // Scroll the instructions panel
        // action.direction: "up" | "down" (default "down"), action.amount: px (default 300)
        const dir = String(action.direction || "down");
        const amt = Number(action.amount || 300);
        const panel = findFirst(STEP_TEXT_SELECTORS);
        const target = panel || document.documentElement;
        target.scrollBy({ top: dir === "up" ? -amt : amt, behavior: "smooth" });
        sendStatus(`Scrolled panel ${dir} ${amt}px`, "info");
        await delay(400);
        break;
      }

      case "paste_text": {
        // Write text to clipboard then Ctrl+V in the VM — useful for multi-line
        // scripts or long commands that are error-prone to type char-by-char.
        const pasteVal = String(action.value || "");
        sendStatus(`Paste via clipboard: "${pasteVal.slice(0, 60)}"`, "info");

        // Attempt 1: modern Clipboard API (works when page has focus + permission)
        let clipboardOk = false;
        try {
          await navigator.clipboard.writeText(pasteVal);
          clipboardOk = true;
        } catch (_) {}

        // Attempt 2: execCommand via a temporary off-screen textarea
        if (!clipboardOk) {
          try {
            const ta = document.createElement("textarea");
            ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
            ta.value = pasteVal;
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            clipboardOk = document.execCommand("copy");
            document.body.removeChild(ta);
          } catch (_) {}
        }

        // Attempt 3: inject clipboard content via background service worker
        // (background has no cross-origin restriction for clipboardWrite)
        if (!clipboardOk) {
          try {
            await new Promise(resolve => {
              chrome.runtime.sendMessage(
                { type: "CLIPBOARD_WRITE", text: pasteVal },
                () => resolve()
              );
            });
            clipboardOk = true;
          } catch (_) {}
        }

        if (!clipboardOk) {
          // Ultimate fallback: type character by character
          sendStatus("Clipboard unavailable — falling back to char-by-char typing", "warn");
          await typeTextNatively(pasteVal);
          break;
        }

        focusVM();
        await delay(300);
        await sendNativeKey("v", 2); // Ctrl+V
        await delay(currentSpeed * 0.3);
        break;
      }

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
  function dispatchActionsToVM(actions) {
    if (!actions || actions.length === 0) return;
    chrome.runtime.sendMessage({ type: "VM_ACTION", actions });
  }

  // Estimate how long a set of actions will take to execute
  function estimateWait(actions) {
    return actions.reduce((acc, a) => {
      if (a.type === "wait") return acc + Number(a.value || 1000);
      if (a.type === "win_run") return acc + 1000 + Number(a.waitAfter || 2500);
      if (a.type === "type_text") return acc + (String(a.value || "").length * 18) + 300;
      if (a.type === "paste_text") return acc + 800; // clipboard write + paste
      if (a.type === "click") return acc + 700;
      if (a.type === "scroll") return acc + 400;
      return acc + 200; // focus_vm, key, shortcut
    }, 0);
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────
  async function clickNext() {
    await delay(currentSpeed * 0.2);
    for (const sel of NEXT_BTN_SELECTORS) {
      try {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled && isVisible(btn)) {
          sendStatus(`Clicking Next: "${btn.innerText?.trim().slice(0, 30) || btn.className}"`, "info");
          btn.scrollIntoView({ behavior: "smooth", block: "center" });
          await delay(300);
          btn.click();
          await delay(currentSpeed);
          return true;
        }
      } catch (_) {}
    }
    // Text-scan fallback
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

  // ─── Verify Button & Result ────────────────────────────────────────────────
  async function clickVerify() {
    const allBtns = [...document.querySelectorAll("button, [role='button']")];
    for (const btn of allBtns) {
      const text = (btn.innerText || btn.getAttribute("aria-label") || "").trim().toLowerCase();
      // ⚠ Deliberately EXCLUDE "submit" and bare "check" — too broad:
      //   "submit" would accidentally submit the whole assignment mid-lab.
      //   "check" matches too many unrelated page elements.
      if (
        (text === "verify" || text === "check work" || text === "verify work" ||
         text === "check answer" || text === "verify step" || text === "check step") &&
        isVisible(btn) && !btn.disabled
      ) {
        sendStatus(`Clicking Verify: "${btn.innerText?.trim()}"`, "info");
        btn.scrollIntoView({ behavior: "smooth", block: "center" });
        await delay(300);
        btn.click();
        return true;
      }
    }
    return false;
  }

  function checkVerificationPassed() {
    const bodyText = document.body.innerText.toLowerCase();
    // Use specific LOD failure phrases — avoid broad words like "incorrect"
    // which appear in instructional text and cause false failures.
    if (
      bodyText.includes("verification failed") ||
      bodyText.includes("task did not pass") ||
      bodyText.includes("did not pass verification") ||
      bodyText.includes("step not complete")
    ) {
      return false;
    }
    // If all visible task checkboxes are checked, verification passed
    const checkboxes = [...document.querySelectorAll("input[type='checkbox']")];
    const visible = checkboxes.filter(cb => isVisible(cb));
    if (visible.length > 0 && !visible.every(cb => cb.checked)) return false;
    return true;
  }

  function isLabComplete() {
    // Use specific phrases — avoid "score:" which appears in instructions
    const keywords = [
      "lab complete", "activity complete", "assignment complete",
      "you have completed", "congratulations", "great job",
      "you scored", "lab finished", "well done",
      "0 minutes remaining", "time expired"
    ];
    const body = document.body.innerText.toLowerCase();
    return keywords.some(kw => body.includes(kw));
  }

  function detectLabContext() {
    const text = (document.title + " " + document.body.innerText.slice(0, 800)).toLowerCase();
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
    if (text.includes("metasploit") || text.includes("nmap") || text.includes("wireshark")) return "Kali Linux cybersecurity lab";
    return "Windows Server lab";
  }

  // ─── Phase 0: Read Entire Task ──────────────────────────────────────────────
  async function readEntireTask(labContext) {
    sendStatus("📋 Phase 0: Reading entire task first...", "info");
    const allText = getAllInstructionsText();
    if (!allText || allText.length < 30) {
      sendStatus("Could not read task instructions — skipping Phase 0.", "warn");
      return [];
    }

    fullTaskText = allText;
    sendStatus(`Task text captured (${allText.length} chars). Sending to AI...`, "info");

    const screenshot = await getScreenshot();
    const prompt = buildReadTaskPrompt(allText, labContext);
    const raw = await askAI(prompt, screenshot);
    if (!raw) {
      sendStatus("AI did not respond during Phase 0.", "warn");
      return [];
    }

    let parsed;
    try {
      parsed = JSON.parse(stripJSON(raw));
    } catch (_) {
      sendStatus("Phase 0 AI response was not valid JSON — continuing without checklist.", "warn");
      return [];
    }

    if (parsed.summary) sendStatus(`Lab summary: ${parsed.summary}`, "info");
    if (parsed.checklist) {
      globalChecklist = parsed.checklist;
      sendStatus(`Checklist built: ${globalChecklist.length} items.`, "info");
      console.log("[VM-Automator][Checklist]", globalChecklist);
    }
    if (parsed.critical_values) {
      sendStatus(`Critical values noted: ${JSON.stringify(parsed.critical_values)}`, "info");
    }

    // Execute any "first_actions" the AI suggests (e.g., click Start, dismiss dialog)
    if (parsed.first_actions && Array.isArray(parsed.first_actions) && parsed.first_actions.length > 0) {
      sendStatus("Executing Phase 0 first actions...", "info");
      dispatchActionsToVM(parsed.first_actions);
      await delay(estimateWait(parsed.first_actions) + 1000);
    }

    return globalChecklist;
  }

  // ─── Per-Step Verification Loop ─────────────────────────────────────────────
  async function executeStepLoop(stepText, labContext) {
    const MAX_ITERATIONS = 16;
    let iterations = 0;
    let previousErrorReason = "";
    let consecutiveVerifyOnly = 0;

    while (iterations < MAX_ITERATIONS && isRunning && !stopRequested) {
      iterations++;
      sendStatus(`🔁 Iteration ${iterations}/${MAX_ITERATIONS} — capturing screen...`, "info");

      const screenshot = await getScreenshot();
      if (!screenshot) {
        sendStatus("Screenshot failed — retrying...", "warn");
        await delay(2000);
        continue;
      }

      const prompt = buildStepPrompt(stepText, labContext, globalChecklist, previousErrorReason);
      previousErrorReason = ""; // reset

      const raw = await askAI(prompt, screenshot);
      if (!raw) {
        sendStatus("AI returned empty response — retrying...", "warn");
        await delay(3000);
        continue;
      }

      let ai;
      try {
        ai = JSON.parse(stripJSON(raw));
      } catch (_) {
        sendStatus("AI response was not valid JSON — retrying...", "warn");
        await delay(2000);
        continue;
      }

      // Log thought
      if (ai.thought) {
        sendStatus(`💭 ${ai.thought.slice(0, 120)}`, "info");
        console.log("[VM-Automator][Thought]", ai.thought);
      }

      // Update global checklist
      if (ai.checklist && Array.isArray(ai.checklist) && ai.checklist.length > 0) {
        globalChecklist = ai.checklist;
        console.log("[VM-Automator][Checklist]", globalChecklist);
        const done = globalChecklist.filter(i => i.startsWith("[✓]")).length;
        sendStatus(`Checklist: ${done}/${globalChecklist.length} done`, "info");
      }

      // Execute actions
      if (ai.actions && ai.actions.length > 0 && ai.status !== "verify_only") {
        sendStatus(`▶ Executing ${ai.actions.length} action(s)...`, "info");
        dispatchActionsToVM(ai.actions);
        const waitMs = estimateWait(ai.actions) + 1000;
        sendStatus(`⏳ Waiting ${Math.round(waitMs / 1000)}s for VM to update...`, "info");
        await delay(waitMs);
      }

      // Handle status
      if (ai.status === "complete") {
        if (ai.report) sendStatus(`✅ ${ai.report.slice(0, 200)}`, "success");
        else sendStatus("✅ AI confirmed step COMPLETE.", "success");
        return true;
      }

      if (ai.status === "verify_only") {
        // AI wants to look at the output without acting
        consecutiveVerifyOnly++;
        sendStatus("👁 Verify-only iteration — re-screenshotting...", "info");
        await delay(1500);
        if (consecutiveVerifyOnly >= 4) {
          // Stuck in verify loop — treat as complete and move on
          sendStatus("Verify-only loop detected — treating step as complete.", "warn");
          return true;
        }
        continue;
      }
      consecutiveVerifyOnly = 0;

      if (ai.status === "error") {
        if (ai.error_reason) {
          sendStatus(`⚠ AI error: ${ai.error_reason}`, "warn");
          previousErrorReason = ai.error_reason;
          // We do NOT stop — we loop back and let the AI try to diagnose
          await delay(2000);
          continue;
        } else {
          sendStatus("AI reported unrecoverable error.", "error");
          return false;
        }
      }

      // Default: in_progress — loop again
      await delay(600);
    }

    sendStatus(`Max iterations (${MAX_ITERATIONS}) reached for this step.`, "warn");
    return false;
  }

  // ─── Phase 3: Pre-Submission Review ─────────────────────────────────────────
  async function preSubmitReview(labContext) {
    sendStatus("🔍 Phase 3: Pre-submission review...", "info");
    if (!fullTaskText) {
      sendStatus("No full task text cached — skipping pre-submission review.", "warn");
      return true;
    }

    const screenshot = await getScreenshot();
    const prompt = buildPreSubmitPrompt(fullTaskText, globalChecklist, labContext);
    const raw = await askAI(prompt, screenshot);
    if (!raw) { sendStatus("AI review failed — proceeding anyway.", "warn"); return true; }

    let review;
    try {
      review = JSON.parse(stripJSON(raw));
    } catch (_) {
      sendStatus("Pre-submit AI response not valid JSON — proceeding.", "warn");
      return true;
    }

    if (review.final_report) {
      sendStatus(`📊 ${review.final_report.slice(0, 300)}`, review.lab_status === "COMPLETE" ? "success" : "warn");
      console.log("[VM-Automator][Final Report]", review.final_report);
    }

    if (review.remaining_items && review.remaining_items.length > 0 &&
        !review.remaining_items.every(i => i.toLowerCase() === "none")) {
      sendStatus(`⚠ Incomplete items: ${review.remaining_items.join("; ")}`, "warn");
    }

    return review.safe_to_submit !== false;
  }

  // ─── Master Loop ─────────────────────────────────────────────────────────────
  async function runVMLab() {
    if (isRunning) { sendStatus("Already running.", "warn"); return; }
    isRunning = true;
    stopRequested = false;
    globalChecklist = [];
    fullTaskText = "";

    sendStatus("🖥️ VM Lab automation starting (v3.0 — Full Agent Mode)...", "info");
    sendStatus(`📍 Running in frame: ${location.href.slice(0, 80)}`, "info");
    await delay(currentSpeed);

    const labContext = detectLabContext();
    sendStatus(`Lab context: ${labContext}`, "info");

    // Phase 0: Read entire task first
    await readEntireTask(labContext);
    if (stopRequested) { isRunning = false; return; }

    let stepCount = 0;
    const MAX_STEPS = 80;
    let lastStepText = "";
    let sameStepCount = 0;

    // Phase 1 & 2: Step loop
    while (isRunning && !stopRequested && stepCount < MAX_STEPS) {
      stepCount++;

      if (isLabComplete()) {
        sendStatus("🎉 Lab complete detected!", "success");
        break;
      }

      const stepText = getCurrentStepText();

      if (!stepText) {
        if (stepCount === 1) {
          // Top frame couldn't find instructions on first attempt — wait and retry
          // rather than hard-stopping (the page may still be loading).
          sendStatus("No instructions on first attempt — waiting for page to load...", "warn");
          await delay(4000);
          continue;
        }
        sendStatus("No step instruction found — waiting...", "warn");
        await delay(3000);
        sameStepCount++;
        if (sameStepCount >= 5) {
          sendStatus("No instructions found after 5 attempts — stopping.", "error");
          break;
        }
        continue;
      }

      sameStepCount = 0;

      if (stepText === lastStepText) {
        sameStepCount++;
        if (sameStepCount >= 4) {
          sendStatus("Step text unchanged after 4 loops — clicking Next to advance.", "warn");
          const advanced = await clickNext();
          if (!advanced) { sendStatus("Cannot advance — stopping.", "error"); break; }
          sameStepCount = 0;
          lastStepText = "";
          await delay(currentSpeed);
          continue;
        }
        sendStatus(`Step unchanged (${sameStepCount}/4) — waiting...`, "warn");
        await delay(currentSpeed);
        continue;
      }

      sameStepCount = 0;
      lastStepText = stepText;
      sendStatus(`📍 Step ${stepCount}: "${stepText.slice(0, 80)}..."`, "info");

      // Phase 1: Execute step with visual verification loop
      const stepSuccess = await executeStepLoop(stepText, labContext);
      if (stopRequested) break;

      if (!stepSuccess) {
        sendStatus("AI could not complete step — attempting to advance anyway.", "warn");
      }

      // Phase 2: Click Verify if present
      const clickedVerify = await clickVerify();
      if (clickedVerify) {
        sendStatus("Waiting for LOD verification scripts to run...", "info");
        await delay(5000);
        const passed = checkVerificationPassed();
        if (!passed) {
          // Demote from hard-stop to warn: some labs show transient failure messages
          // that clear after a moment; don't halt the entire run.
          sendStatus("⚠ Verification may have failed — review the result above. Continuing...", "warn");
        } else {
          sendStatus("✅ Verification PASSED!", "success");
        }
      }

      await delay(currentSpeed * 0.5);

      // Advance to next step
      await clickNext();
      await delay(currentSpeed);
    }

    // Phase 3: Pre-submission review
    if (!stopRequested && !isLabComplete()) {
      await preSubmitReview(labContext);
    }

    if (stepCount >= MAX_STEPS) sendStatus("Max steps reached.", "warn");
    isRunning = false;
    releaseMasterLock();
    sendStatus("🏁 VM lab automation ended.", "info");
  }

  // ─── Single Step Mode ────────────────────────────────────────────────────────
  async function stepOnceVM() {
    const labContext = detectLabContext();
    const stepText = getCurrentStepText();
    if (!stepText) {
      // Likely the canvas frame — silent exit
      return;
    }
    sendStatus(`▶ Single step: "${stepText.slice(0, 80)}"`, "info");

    const success = await executeStepLoop(stepText, labContext);
    if (!success) {
      sendStatus("AI could not complete this step.", "warn");
      return;
    }

    // Click verify if available
    const clickedVerify = await clickVerify();
    if (clickedVerify) {
      sendStatus("Waiting for verification...", "info");
      await delay(4000);
      const passed = checkVerificationPassed();
      sendStatus(passed ? "✅ Verification PASSED!" : "⛔ Verification FAILED!", passed ? "success" : "error");
    }

    await clickNext();
  }

  // ─── Message Handler ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === "START_VM_LAB") {
      // Guard: if already running in this frame, ignore the duplicate message.
      if (isRunning) { sendResponse({ ok: true }); return true; }
      // Use the master lock to elect exactly ONE frame as controller.
      // The frame with the highest capability priority wins (instructions > canvas > unknown).
      tryAcquireMasterLock().then(isMaster => {
        IS_MASTER_FRAME = isMaster;
        const cap = IS_CANVAS_FRAME ? "canvas" : (isMaster ? "instructions" : "unknown");
        if (isMaster) {
          sendStatus(`🔒 Master frame elected [${cap}] — starting control loop. URL: ${location.href.slice(0, 60)}`, "info");
          currentSpeed = speedToMs(msg.speed || 2);
          runVMLab();
        } else {
          sendStatus(`🔕 Sub-frame [${cap}]: will execute VM actions only. URL: ${location.href.slice(0, 60)}`, "info");
        }
      });
      sendResponse({ ok: true });
    }

    if (msg.type === "STOP_AUTOMATION") {
      stopRequested = true;
      isRunning = false;
      if (IS_MASTER_FRAME) {
        releaseMasterLock();
        sendStatus("VM lab stopped by user.", "warn");
      }
      sendResponse({ ok: true });
    }

    if (msg.type === "STEP_ONCE_VM") {
      tryAcquireMasterLock().then(isMaster => {
        IS_MASTER_FRAME = isMaster;
        if (isMaster) {
          currentSpeed = speedToMs(msg.speed || 2);
          stepOnceVM();
        }
      });
      sendResponse({ ok: true });
    }

    if (msg.type === "VM_ACTION") {
      // Execute keystrokes in frames that have the VM canvas.
      // IS_CANVAS_FRAME is set during capability probe at startup (probeCapability).
      // Also check live in case the canvas loaded after the probe.
      const hasCanvas = IS_CANVAS_FRAME || !!getVMCanvas() || !!document.querySelector("canvas");
      if (hasCanvas && !IS_MASTER_FRAME) {
        // Sub-frame with canvas: execute and ACK
        executeActionsLocally(msg.actions);
        sendResponse({ executed: true, frame: "sub" });
      } else if (hasCanvas && IS_MASTER_FRAME) {
        // Master frame also has the canvas (single-frame LOD layout)
        executeActionsLocally(msg.actions);
        sendResponse({ executed: true, frame: "master-canvas" });
      } else {
        sendResponse({ executed: false });
      }
    }

    if (msg.type === "PING") {
      sendResponse({ alive: true, mode: "vm-lab", isMaster: IS_MASTER_FRAME });
    }

    return true;
  });

  // Announce load from ALL frames so we can see injection in devtools;
  // status goes to background but duplicate suppression is handled by the master lock.
  sendStatus(`🖥️ VM Lab Automator v3.0 loaded (frame: ${location.href.slice(0, 60)}) — open popup to start.`, "info");

})();
