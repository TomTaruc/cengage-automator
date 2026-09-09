// modules/fillin.js
// Handles fill-in-the-blank, text input, and short answer fields in MindTap.

import { generateAnswer } from "./ai.js";
import { delay } from "./utils.js";

const QUESTION_SELECTORS = [
  "[class*='question-stem']",
  "[class*='question-text']",
  "[class*='question-body']",
  "[class*='prompt']",
  ".stem",
  ".question",
  "p[class*='question']"
];

const INPUT_SELECTORS = [
  "input[type='text']",
  "input[type='number']",
  "input[type='email']",
  "textarea",
  "[contenteditable='true'][class*='answer']",
  "[contenteditable='true'][class*='response']",
  "[contenteditable='true'][role='textbox']"
];

function getQuestionText(container = document) {
  for (const sel of QUESTION_SELECTORS) {
    const el = container.querySelector(sel);
    if (el && el.innerText.trim()) return el.innerText.trim();
  }
  // Extract text content minus form fields
  const clone = container.cloneNode(true);
  clone.querySelectorAll("input, textarea, button, [contenteditable]").forEach(e => e.remove());
  return clone.innerText.trim().slice(0, 600);
}

/**
 * Type into a native input or contenteditable element.
 */
function typeIntoField(el, text) {
  el.focus();
  if (el.isContentEditable) {
    el.innerText = "";
    el.focus();
    document.execCommand("insertText", false, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    // Native input value setter to bypass React's synthetic events
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value"
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }
}

/**
 * Handle a single fill-in-the-blank question container.
 */
async function handleOneFillin(container, speed) {
  const question = getQuestionText(container);
  const inputs = [...container.querySelectorAll(INPUT_SELECTORS.join(","))];
  if (!inputs.length) return;

  for (const input of inputs) {
    // Skip hidden or already filled inputs
    if (input.style.display === "none" || input.disabled) continue;
    if (input.value && input.value.trim()) continue;

    // Try to get a more targeted label for multi-blank questions
    let label = question;
    const nearbyLabel = input.closest("label") || input.previousElementSibling;
    if (nearbyLabel && nearbyLabel.innerText.trim()) {
      label = nearbyLabel.innerText.trim() + " (Context: " + question + ")";
    }

    console.log("[Automator] Fill-in question:", label.slice(0, 120));
    const answer = await generateAnswer(label);
    console.log("[Automator] Fill-in answer:", answer);

    await delay(speed * 0.3);
    typeIntoField(input, answer);
    await delay(speed * 0.5);
  }
}

/**
 * Main handler: find all fill-in fields on the page and answer them.
 */
export async function handleFillin(speed = 1000) {
  // Try to find question containers first for better context
  const containers = document.querySelectorAll(
    "[class*='question-container'], [class*='item-container'], [class*='question-item'], [class*='fill-blank']"
  );

  if (containers.length > 0) {
    for (const c of containers) {
      await handleOneFillin(c, speed);
    }
  } else {
    // Fallback: handle all inputs on page together
    await handleOneFillin(document, speed);
  }
  return true;
}
