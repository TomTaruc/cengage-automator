// modules/coding.js
// Handles coding labs in MindTap (CodeMirror, Monaco, Ace, raw textarea).

import { generateCode } from "./ai.js";
import { delay } from "./utils.js";

const PROBLEM_SELECTORS = [
  "[class*='problem-statement']",
  "[class*='instructions']",
  "[class*='task-description']",
  "[class*='lab-description']",
  "[class*='coding-prompt']",
  "[class*='exercise-description']",
  ".description",
  ".instructions",
  ".problem"
];

/**
 * Detect editor type and return a handler object.
 */
function detectEditor() {
  // CodeMirror 5
  const cm5 = document.querySelector(".CodeMirror");
  if (cm5 && cm5.CodeMirror) {
    return { type: "codemirror5", instance: cm5.CodeMirror };
  }

  // CodeMirror 6 (uses .cm-editor)
  const cm6 = document.querySelector(".cm-editor");
  if (cm6) {
    return { type: "codemirror6", el: cm6 };
  }

  // Monaco
  if (window.monaco) {
    const monacoModels = window.monaco.editor.getModels();
    if (monacoModels.length > 0) {
      return { type: "monaco", models: monacoModels };
    }
  }

  // Ace editor
  const aceEl = document.querySelector(".ace_editor");
  if (aceEl && window.ace) {
    return { type: "ace", instance: window.ace.edit(aceEl) };
  }

  // Raw textarea
  const ta = document.querySelector("textarea[class*='code'], textarea[class*='editor'], .code-editor textarea, textarea");
  if (ta) return { type: "textarea", el: ta };

  return null;
}

/**
 * Detect the coding language from the page.
 */
function detectLanguage() {
  const hints = [
    document.querySelector("[class*='language']"),
    document.querySelector("[data-language]"),
    document.querySelector("[class*='lang']")
  ].filter(Boolean);

  for (const el of hints) {
    const lang = el.getAttribute("data-language") ||
                 el.className.match(/lang(?:uage)?[-_]?(\w+)/i)?.[1] ||
                 el.innerText.trim().toLowerCase();
    if (lang) return lang;
  }

  // Sniff from file extension or page title
  const title = document.title.toLowerCase();
  if (title.includes("python")) return "python";
  if (title.includes("java"))   return "java";
  if (title.includes("c++") || title.includes("cpp")) return "cpp";
  if (title.includes("javascript") || title.includes("js")) return "javascript";
  if (title.includes("html"))   return "html";
  if (title.includes("sql"))    return "sql";

  return "python"; // default
}

/**
 * Inject code into a CodeMirror 5 instance.
 */
function injectCodeMirror5(cm, code) {
  cm.setValue(code);
  cm.refresh();
}

/**
 * Inject code into a CodeMirror 6 editor via keyboard events.
 */
async function injectCodeMirror6(el, code) {
  const contentEl = el.querySelector(".cm-content");
  if (!contentEl) return;
  contentEl.focus();
  // Select all existing content
  document.execCommand("selectAll");
  await delay(100);
  document.execCommand("insertText", false, code);
  contentEl.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Inject code into Monaco editor.
 */
function injectMonaco(models, code) {
  // Use the first writable model
  for (const model of models) {
    try {
      model.setValue(code);
      return;
    } catch (_) {}
  }
}

/**
 * Inject code into Ace editor.
 */
function injectAce(instance, code) {
  instance.setValue(code, -1);
}

/**
 * Inject code into a plain textarea.
 */
function injectTextarea(el, code) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, "value"
  )?.set;
  if (nativeSetter) nativeSetter.call(el, code);
  else el.value = code;
  el.dispatchEvent(new Event("input",  { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Get the problem/instructions text from the page.
 */
function getProblemText() {
  for (const sel of PROBLEM_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim()) return el.innerText.trim();
  }
  // Fallback: grab visible text excluding editor area
  const body = document.body.cloneNode(true);
  body.querySelectorAll(".CodeMirror, .cm-editor, .monaco-editor, .ace_editor, textarea").forEach(e => e.remove());
  return body.innerText.trim().slice(0, 1200);
}

/**
 * Main handler: detect editor, get problem, generate code, inject.
 */
export async function handleCoding(speed = 1000) {
  const editor = detectEditor();
  if (!editor) {
    console.warn("[Automator] Coding: No code editor found.");
    return false;
  }

  const language = detectLanguage();
  const problem  = getProblemText();

  console.log("[Automator] Coding lab detected. Language:", language);
  console.log("[Automator] Problem:", problem.slice(0, 200));

  // Also check for existing code to use as context
  let existingCode = "";
  try {
    if (editor.type === "codemirror5")  existingCode = editor.instance.getValue();
    if (editor.type === "ace")          existingCode = editor.instance.getValue();
    if (editor.type === "monaco")       existingCode = editor.models[0].getValue();
    if (editor.type === "textarea")     existingCode = editor.el.value;
  } catch (_) {}

  const fullPrompt = problem + (existingCode ? `\n\nExisting code (complete or modify it):\n${existingCode}` : "");
  const code = await generateCode(fullPrompt, language);

  if (!code) {
    console.warn("[Automator] Coding: AI returned empty code.");
    return false;
  }

  console.log("[Automator] Injecting code:\n", code.slice(0, 300));
  await delay(speed * 0.5);

  switch (editor.type) {
    case "codemirror5": injectCodeMirror5(editor.instance, code); break;
    case "codemirror6": await injectCodeMirror6(editor.el, code); break;
    case "monaco":      injectMonaco(editor.models, code); break;
    case "ace":         injectAce(editor.instance, code); break;
    case "textarea":    injectTextarea(editor.el, code); break;
  }

  await delay(speed);
  return true;
}
