// =============================================================================
// Cengage MindTap Automator — content.js (Self-contained bundle)
// Chrome MV3 content scripts do not support ES module imports,
// so all modules are inlined here in a single IIFE.
// =============================================================================

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: utils
  // ═══════════════════════════════════════════════════════════════════════════
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(ms, 100)));
  }

  function sendStatus(message, type = "info") {
    try { chrome.runtime.sendMessage({ type: "STATUS_UPDATE", message, statusType: type }); } catch (_) {}
    console.log(`[Automator][${type.toUpperCase()}] ${message}`);
  }

  function waitForElement(selector, timeout = 8000) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { clearTimeout(timer); observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  function speedToMs(speed) {
    switch (parseInt(speed, 10)) {
      case 3: return 400;
      case 2: return 1000;
      default: return 2000;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: AI
  // ═══════════════════════════════════════════════════════════════════════════
  function askAI(prompt) {
    return new Promise((resolve) => {
      chrome.storage.sync.get(["apiKey"], ({ apiKey }) => {
        if (!apiKey) { resolve(""); return; }
        chrome.runtime.sendMessage({ type: "ASK_AI", prompt, apiKey }, (resp) => {
          if (chrome.runtime.lastError || !resp) { resolve(""); return; }
          resolve(resp.text || "");
        });
      });
    });
  }

  async function pickBestOption(question, options) {
    const numbered = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    const prompt = `You are helping a student answer a multiple choice question correctly.
Question: ${question}
Options:
${numbered}

Reply with ONLY the number of the correct answer (e.g. "2"). No explanation.`;
    const ans = await askAI(prompt);
    const n = parseInt(ans, 10);
    if (!isNaN(n) && n >= 1 && n <= options.length) return n - 1;
    return 0;
  }

  async function generateAnswer(question, context = "") {
    const prompt = `You are answering a student fill-in-the-blank or short answer question.
${context ? "Context: " + context + "\n" : ""}Question: ${question}

Reply with ONLY the answer text, as concise as possible (a word, phrase, or short sentence). No explanation.`;
    return await askAI(prompt);
  }

  async function generateCode(problemStatement, language = "python") {
    const prompt = `You are completing a coding lab exercise.
Language: ${language}
Problem:
${problemStatement}

Reply with ONLY the complete, correct code. No markdown fences, no explanation.`;
    return await askAI(prompt);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: detector
  // ═══════════════════════════════════════════════════════════════════════════
  const ActivityType = { MCQ: "mcq", FILLIN: "fillin", LAB: "lab", CODING: "coding", UNKNOWN: "unknown" };

  function detectActivity() {
    if (
      document.querySelector(".CodeMirror") ||
      document.querySelector(".monaco-editor") ||
      document.querySelector("[data-cy='code-editor']") ||
      document.querySelector(".coding-lab") ||
      document.querySelector(".ace_editor")
    ) return ActivityType.CODING;

    if (
      document.querySelector(".lab-step") ||
      document.querySelector("[class*='labStep']") ||
      document.querySelector("[class*='lab-instruction']") ||
      document.querySelector("[class*='step-instruction']") ||
      document.querySelector(".activity-step") ||
      (document.querySelector("[class*='instruction']") && document.querySelector("[class*='task-pane']"))
    ) return ActivityType.LAB;

    const radios = document.querySelectorAll("input[type='radio'], input[type='checkbox']");
    const optionCards = document.querySelectorAll(
      "[class*='option'], [class*='choice'], [class*='answer-option'], [role='radio'], [role='option']"
    );
    if (radios.length > 0 || optionCards.length > 0) return ActivityType.MCQ;

    const inputs = document.querySelectorAll(
      "input[type='text'], input[type='number'], textarea, [contenteditable='true']"
    );
    if (inputs.length > 0) return ActivityType.FILLIN;

    return ActivityType.UNKNOWN;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: MCQ
  // ═══════════════════════════════════════════════════════════════════════════
  const OPTION_SELECTORS = [
    "input[type='radio']", "input[type='checkbox']", "[role='radio']", "[role='checkbox']",
    "[class*='answer-option']", "[class*='choice-item']", "[class*='option-item']",
    "[class*='mc-option']", "[class*='response-choice']", "li[class*='choice']",
    "li[class*='option']", ".answer-choice", ".response-option"
  ];

  const QUESTION_SELECTORS = [
    "[class*='question-stem']", "[class*='question-text']", "[class*='question-body']",
    ".stem", ".question", "[role='heading']", "[class*='prompt']"
  ];

  function getQuestionText(container = document) {
    for (const sel of QUESTION_SELECTORS) {
      const el = container.querySelector(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    const clone = container.cloneNode(true);
    clone.querySelectorAll("input, textarea, button, [contenteditable]").forEach(e => e.remove());
    return clone.innerText.trim().slice(0, 600);
  }

  function getOptionElements(container = document) {
    for (const sel of OPTION_SELECTORS) {
      const els = [...container.querySelectorAll(sel)];
      if (els.length > 0) return els;
    }
    return [];
  }

  function getOptionLabel(el) {
    if (el.tagName === "INPUT") {
      const label = el.closest("label") || document.querySelector(`label[for='${el.id}']`);
      if (label) return label.innerText.trim();
      const sibling = el.nextElementSibling;
      if (sibling) return sibling.innerText.trim();
    }
    return el.innerText.trim() || el.getAttribute("aria-label") || "";
  }

  function simulateClick(el) {
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click",     { bubbles: true }));
    if (el.tagName === "INPUT") el.checked = true;
  }

  async function handleMCQSet(speed = 1000) {
    const containers = document.querySelectorAll(
      "[class*='question-container'], [class*='item-container'], [class*='question-item']"
    );
    const list = containers.length > 1 ? [...containers] : [document];
    for (const container of list) {
      const question = getQuestionText(container);
      const optionEls = getOptionElements(container);
      if (!optionEls.length) continue;
      const labels = optionEls.map(getOptionLabel);
      sendStatus(`MCQ: "${question.slice(0, 60)}..."`, "info");
      const chosenIndex = await pickBestOption(question, labels);
      sendStatus(`Selecting: "${labels[chosenIndex]}"`, "info");
      await delay(speed * 0.4);
      simulateClick(optionEls[chosenIndex]);
      await delay(speed * 0.5);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: Fill-in
  // ═══════════════════════════════════════════════════════════════════════════
  const FILLIN_INPUT_SELECTORS = [
    "input[type='text']", "input[type='number']", "input[type='email']",
    "textarea", "[contenteditable='true'][class*='answer']",
    "[contenteditable='true'][class*='response']", "[contenteditable='true'][role='textbox']"
  ];

  function typeIntoField(el, text) {
    el.focus();
    if (el.isContentEditable) {
      el.innerText = "";
      el.focus();
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) nativeSetter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input",  { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    }
  }

  async function handleFillinContainer(container, speed) {
    const question = getQuestionText(container);
    const inputs = [...container.querySelectorAll(FILLIN_INPUT_SELECTORS.join(","))];
    for (const input of inputs) {
      if (input.style.display === "none" || input.disabled) continue;
      if (input.value && input.value.trim()) continue;
      let label = question;
      const nearbyLabel = input.closest("label") || input.previousElementSibling;
      if (nearbyLabel && nearbyLabel.innerText?.trim()) {
        label = nearbyLabel.innerText.trim() + " (context: " + question + ")";
      }
      sendStatus(`Fill-in: "${label.slice(0, 70)}"`, "info");
      const answer = await generateAnswer(label);
      sendStatus(`Answer: "${answer}"`, "info");
      await delay(speed * 0.3);
      typeIntoField(input, answer);
      await delay(speed * 0.4);
    }
  }

  async function handleFillin(speed = 1000) {
    const containers = document.querySelectorAll(
      "[class*='question-container'], [class*='item-container'], [class*='question-item'], [class*='fill-blank']"
    );
    if (containers.length > 0) {
      for (const c of containers) await handleFillinContainer(c, speed);
    } else {
      await handleFillinContainer(document, speed);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: Coding Lab
  // ═══════════════════════════════════════════════════════════════════════════
  const PROBLEM_SELECTORS = [
    "[class*='problem-statement']", "[class*='instructions']", "[class*='task-description']",
    "[class*='lab-description']", "[class*='coding-prompt']", "[class*='exercise-description']",
    ".description", ".instructions", ".problem"
  ];

  function detectEditor() {
    const cm5 = document.querySelector(".CodeMirror");
    if (cm5 && cm5.CodeMirror) return { type: "codemirror5", instance: cm5.CodeMirror };
    const cm6 = document.querySelector(".cm-editor");
    if (cm6) return { type: "codemirror6", el: cm6 };
    if (window.monaco) {
      const models = window.monaco.editor.getModels();
      if (models.length > 0) return { type: "monaco", models };
    }
    const aceEl = document.querySelector(".ace_editor");
    if (aceEl && window.ace) return { type: "ace", instance: window.ace.edit(aceEl) };
    const ta = document.querySelector("textarea[class*='code'], textarea[class*='editor'], .code-editor textarea, textarea");
    if (ta) return { type: "textarea", el: ta };
    return null;
  }

  function detectLanguage() {
    const title = document.title.toLowerCase();
    if (title.includes("python"))   return "python";
    if (title.includes("java"))     return "java";
    if (title.includes("c++") || title.includes("cpp")) return "cpp";
    if (title.includes("javascript") || title.includes("js")) return "javascript";
    if (title.includes("html"))     return "html";
    if (title.includes("sql"))      return "sql";
    const langEl = document.querySelector("[data-language], [class*='language']");
    if (langEl) return langEl.getAttribute("data-language") || "python";
    return "python";
  }

  function getProblemText() {
    for (const sel of PROBLEM_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    const body = document.body.cloneNode(true);
    body.querySelectorAll(".CodeMirror, .cm-editor, .monaco-editor, .ace_editor, textarea").forEach(e => e.remove());
    return body.innerText.trim().slice(0, 1200);
  }

  async function injectCodeMirror6(el, code) {
    const contentEl = el.querySelector(".cm-content");
    if (!contentEl) return;
    contentEl.focus();
    document.execCommand("selectAll");
    await delay(100);
    document.execCommand("insertText", false, code);
    contentEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function handleCoding(speed = 1000) {
    const editor = detectEditor();
    if (!editor) { sendStatus("No code editor found.", "warn"); return false; }
    const language = detectLanguage();
    const problem  = getProblemText();
    sendStatus(`Coding lab — language: ${language}`, "info");
    let existingCode = "";
    try {
      if (editor.type === "codemirror5") existingCode = editor.instance.getValue();
      if (editor.type === "ace")         existingCode = editor.instance.getValue();
      if (editor.type === "monaco")      existingCode = editor.models[0].getValue();
      if (editor.type === "textarea")    existingCode = editor.el.value;
    } catch (_) {}
    const fullPrompt = problem + (existingCode ? `\n\nExisting code:\n${existingCode}` : "");
    const code = await generateCode(fullPrompt, language);
    if (!code) { sendStatus("AI returned empty code.", "warn"); return false; }
    sendStatus("Injecting generated code...", "info");
    await delay(speed * 0.5);
    switch (editor.type) {
      case "codemirror5": editor.instance.setValue(code); editor.instance.refresh(); break;
      case "codemirror6": await injectCodeMirror6(editor.el, code); break;
      case "monaco": for (const m of editor.models) { try { m.setValue(code); break; } catch (_) {} } break;
      case "ace": editor.instance.setValue(code, -1); break;
      case "textarea":
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        if (nativeSetter) nativeSetter.call(editor.el, code); else editor.el.value = code;
        editor.el.dispatchEvent(new Event("input",  { bubbles: true }));
        editor.el.dispatchEvent(new Event("change", { bubbles: true }));
        break;
    }
    await delay(speed);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: Lab simulation
  // ═══════════════════════════════════════════════════════════════════════════
  const LAB_INSTRUCTION_SELECTORS = [
    "[class*='lab-step']", "[class*='step-instruction']", "[class*='lab-instruction']",
    "[class*='task-description']", "[class*='activity-instruction']", "[class*='step-text']",
    "[class*='instruction-text']", ".instruction", ".task", ".step"
  ];

  function getStepInstruction() {
    for (const sel of LAB_INSTRUCTION_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim()) return el.innerText.trim();
    }
    return "";
  }

  function collectInteractables() {
    const tags = ["button", "a", "input", "select", "textarea", "[role='button']",
                  "[role='tab']", "[role='menuitem']", "[role='link']",
                  "[class*='btn']", "[class*='clickable']", "[class*='selectable']"];
    return [...document.querySelectorAll(tags.join(","))]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .map((el, i) => ({
        index: i,
        element: el,
        description: [
          el.innerText?.trim(), el.getAttribute("aria-label"), el.getAttribute("title"),
          el.getAttribute("value"), el.getAttribute("placeholder"),
          el.tagName.toLowerCase(), el.className.slice(0, 60)
        ].filter(Boolean).join(" | ").slice(0, 120)
      }))
      .filter(d => d.description.trim().length > 0);
  }

  async function identifyTarget(instruction, interactables) {
    if (!instruction || !interactables.length) return null;
    const elList = interactables.slice(0, 30).map(d => `${d.index}: ${d.description}`).join("\n");
    const prompt = `You are helping automate a lab simulation step.
Current instruction: "${instruction}"
Available interactive elements (index: description):
${elList}
Which element index should be clicked? Reply with ONLY the number. If none match, reply "none".`;
    const result = await askAI(prompt);
    const n = parseInt(result, 10);
    if (!isNaN(n) && interactables[n]) return interactables[n].element;
    return null;
  }

  async function clickLabNextStep(speed) {
    const nextSelectors = [
      "button[class*='next']", "button[class*='continue']", "button[class*='proceed']",
      "button[class*='submit']", "[class*='step-btn']", "[class*='next-step']"
    ];
    for (const sel of nextSelectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) { await delay(speed * 0.5); btn.click(); return true; }
    }
    return false;
  }

  async function handleLab(speed = 1500, maxSteps = 60) {
    let stepsDone = 0;
    let lastInstruction = "";
    while (stepsDone < maxSteps) {
      await delay(speed);
      const instruction = getStepInstruction();
      if (!instruction) { sendStatus("Lab: no instruction found — done.", "info"); break; }
      if (instruction === lastInstruction) {
        sendStatus("Lab: instruction unchanged, advancing...", "warn");
        const advanced = await clickLabNextStep(speed);
        if (!advanced) break;
        stepsDone++;
        continue;
      }
      sendStatus(`Lab step ${stepsDone + 1}: "${instruction.slice(0, 80)}"`, "info");
      lastInstruction = instruction;
      const interactables = collectInteractables();
      const target = await identifyTarget(instruction, interactables);
      if (target) {
        sendStatus(`Clicking: ${target.innerText || target.className}`, "info");
        await delay(speed * 0.3);
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        await delay(300);
        target.click();
      }
      await delay(speed * 0.5);
      await clickLabNextStep(speed * 0.5);
      stepsDone++;
    }
    sendStatus(`Lab done. ${stepsDone} steps.`, "success");
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULE: Navigator
  // ═══════════════════════════════════════════════════════════════════════════
  const ADVANCE_SELECTORS = [
    "button[data-testid='submit-btn']", "button[data-testid='next-btn']",
    "button[data-testid='check-btn']", "[class*='btn-submit']", "[class*='btn-next']",
    "[class*='btn-check']", "[class*='submit-button']", "[class*='next-button']",
    "[class*='check-button']", "button[type='submit']"
  ];

  const ADVANCE_TEXT_PATTERNS = [
    /^(submit|submit answer|submit all)$/i,
    /^(check answer|check|grade)$/i,
    /^(next|next question|next page|next activity)$/i,
    /^(continue|proceed|go|done)$/i,
    /^(finish|complete)$/i
  ];

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function findAdvanceButton() {
    for (const sel of ADVANCE_SELECTORS) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && isVisible(btn)) return btn;
    }
    const allButtons = [...document.querySelectorAll(
      "button, [role='button'], input[type='button'], input[type='submit'], a[class*='btn']"
    )];
    for (const pattern of ADVANCE_TEXT_PATTERNS) {
      for (const btn of allButtons) {
        if (btn.disabled || !isVisible(btn)) continue;
        const text = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").trim();
        if (pattern.test(text)) return btn;
      }
    }
    return null;
  }

  function waitForPageAdvance(timeout = 8000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
      const observer = new MutationObserver(() => {
        clearTimeout(timer); observer.disconnect(); resolve(true);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  async function advance(speed = 1000) {
    await delay(speed * 0.5);
    const btn = findAdvanceButton();
    if (!btn) { sendStatus("No advance button found.", "warn"); return false; }
    btn.scrollIntoView({ behavior: "smooth", block: "center" });
    await delay(300);
    btn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await delay(100);
    btn.click();
    sendStatus(`Clicked: "${btn.innerText || btn.value}"`, "info");
    await waitForPageAdvance(10000);
    await delay(speed);
    return true;
  }

  async function confirmDialog(speed = 500) {
    await delay(speed);
    const patterns = [/^(yes|ok|confirm|accept|submit)$/i];
    const allButtons = [...document.querySelectorAll("button, [role='button']")];
    for (const pattern of patterns) {
      for (const btn of allButtons) {
        if (!btn.disabled && isVisible(btn)) {
          const text = btn.innerText?.trim() || "";
          if (pattern.test(text)) { btn.click(); await delay(speed); return true; }
        }
      }
    }
    return false;
  }

  function isAssignmentComplete() {
    const endKeywords = ["great job", "assignment complete", "you've finished",
                         "congratulations", "well done", "score:", "activity complete",
                         "lab complete", "you scored"];
    const body = document.body.innerText.toLowerCase();
    return endKeywords.some(kw => body.includes(kw));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MASTER ORCHESTRATOR
  // ═══════════════════════════════════════════════════════════════════════════
  let isRunning = false;
  let stopRequested = false;
  let currentSpeed = 1000;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "START_AUTOMATION") {
      currentSpeed = speedToMs(msg.speed || 2);
      startAutomation();
      sendResponse({ ok: true });
    }
    if (msg.type === "STOP_AUTOMATION") {
      stopRequested = true;
      isRunning = false;
      sendStatus("Automation stopped by user.", "warn");
      sendResponse({ ok: true });
    }
    if (msg.type === "STEP_ONCE") {
      currentSpeed = speedToMs(msg.speed || 2);
      stepOnce();
      sendResponse({ ok: true });
    }
    if (msg.type === "PING") {
      sendResponse({ alive: true });
    }
    return true;
  });

  async function startAutomation() {
    if (isRunning) { sendStatus("Already running.", "warn"); return; }
    isRunning = true;
    stopRequested = false;
    sendStatus("Starting automation...", "info");
    await delay(currentSpeed);
    let iterations = 0;
    const MAX_ITER = 200;

    while (isRunning && !stopRequested && iterations < MAX_ITER) {
      iterations++;
      if (isAssignmentComplete()) {
        sendStatus("🎉 Assignment complete!", "success");
        isRunning = false;
        break;
      }
      const activityType = detectActivity();
      sendStatus(`Detected: ${activityType} (step ${iterations})`, "info");
      try {
        if (activityType === ActivityType.MCQ)     await handleMCQSet(currentSpeed);
        if (activityType === ActivityType.FILLIN)  await handleFillin(currentSpeed);
        if (activityType === ActivityType.CODING)  await handleCoding(currentSpeed);
        if (activityType === ActivityType.LAB) {
          await handleLab(currentSpeed);
          isRunning = false;
          return;
        }
      } catch (err) {
        sendStatus(`Handler error: ${err.message}`, "error");
      }
      await delay(currentSpeed * 0.5);
      await confirmDialog(500);
      const advanced = await advance(currentSpeed);
      if (!advanced) {
        sendStatus("Could not advance — stopping.", "error");
        isRunning = false;
        break;
      }
      await delay(currentSpeed);
    }

    if (iterations >= MAX_ITER) sendStatus("Max iterations reached.", "warn");
    isRunning = false;
  }

  async function stepOnce() {
    const activityType = detectActivity();
    sendStatus(`Step: ${activityType}`, "info");
    try {
      if (activityType === ActivityType.MCQ)    await handleMCQSet(currentSpeed);
      if (activityType === ActivityType.FILLIN) await handleFillin(currentSpeed);
      if (activityType === ActivityType.CODING) await handleCoding(currentSpeed);
    } catch (err) {
      sendStatus(`Step error: ${err.message}`, "error");
    }
    await delay(currentSpeed * 0.5);
    await confirmDialog(300);
    await advance(currentSpeed);
  }

  sendStatus("Cengage Automator loaded. Open the extension popup to start.", "info");

})();
