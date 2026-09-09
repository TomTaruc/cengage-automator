// modules/mcq.js
// Handles multiple-choice and true/false questions in MindTap.

import { pickBestOption } from "./ai.js";
import { delay } from "./utils.js";

// Common selectors used by MindTap for MCQ
const OPTION_SELECTORS = [
  "input[type='radio']",
  "input[type='checkbox']",
  "[role='radio']",
  "[role='checkbox']",
  "[class*='answer-option']",
  "[class*='choice-item']",
  "[class*='option-item']",
  "[class*='mc-option']",
  "[class*='response-choice']",
  "li[class*='choice']",
  "li[class*='option']",
  ".answer-choice",
  ".response-option"
];

const QUESTION_SELECTORS = [
  "[class*='question-stem']",
  "[class*='question-text']",
  "[class*='question-body']",
  ".stem",
  ".question",
  "[role='heading']",
  "[class*='prompt']"
];

/**
 * Get question text from the page.
 */
function getQuestionText() {
  for (const sel of QUESTION_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim()) return el.innerText.trim();
  }
  // Fallback: grab largest text block
  return document.body.innerText.slice(0, 500);
}

/**
 * Get all clickable option elements on the page.
 */
function getOptionElements() {
  for (const sel of OPTION_SELECTORS) {
    const els = [...document.querySelectorAll(sel)];
    if (els.length > 0) return els;
  }
  return [];
}

/**
 * Get the label text for an option element.
 */
function getOptionLabel(el) {
  // If it's an input, look for associated label
  if (el.tagName === "INPUT") {
    const label =
      el.closest("label") ||
      document.querySelector(`label[for='${el.id}']`);
    if (label) return label.innerText.trim();
    // Try sibling span / div
    const sibling = el.nextElementSibling;
    if (sibling) return sibling.innerText.trim();
  }
  return el.innerText.trim() || el.getAttribute("aria-label") || "";
}

/**
 * Simulate a realistic click on an element.
 */
function simulateClick(el) {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true }));
  el.dispatchEvent(new MouseEvent("click",     { bubbles: true }));
  if (el.tagName === "INPUT") el.checked = true;
}

/**
 * Main handler: answer all MCQ questions on the current page/container.
 * Uses AI to pick the best option.
 */
export async function handleMCQ(speed = 1000) {
  const question = getQuestionText();
  const optionEls = getOptionElements();

  if (optionEls.length === 0) {
    console.warn("[Automator] MCQ: No option elements found.");
    return false;
  }

  const labels = optionEls.map(getOptionLabel);
  console.log("[Automator] MCQ question:", question);
  console.log("[Automator] MCQ options:", labels);

  let chosenIndex = 0;
  try {
    chosenIndex = await pickBestOption(question, labels);
  } catch (e) {
    console.warn("[Automator] AI failed, defaulting to option 0:", e);
  }

  console.log(`[Automator] Clicking option ${chosenIndex}: "${labels[chosenIndex]}"`);
  await delay(speed * 0.5);
  simulateClick(optionEls[chosenIndex]);
  await delay(speed);
  return true;
}

/**
 * Handle multiple questions on a single page (question sets).
 */
export async function handleMCQSet(speed = 1000) {
  // Look for individual question containers
  const containers = document.querySelectorAll(
    "[class*='question-container'], [class*='item-container'], [class*='question-item']"
  );
  if (containers.length <= 1) {
    return await handleMCQ(speed);
  }

  for (const container of containers) {
    const questionEl = container.querySelector(QUESTION_SELECTORS.join(","));
    const question = questionEl ? questionEl.innerText.trim() : container.innerText.slice(0, 300);

    let optionEls = [];
    for (const sel of OPTION_SELECTORS) {
      optionEls = [...container.querySelectorAll(sel)];
      if (optionEls.length) break;
    }
    if (!optionEls.length) continue;

    const labels = optionEls.map(getOptionLabel);
    const chosenIndex = await pickBestOption(question, labels);
    await delay(speed * 0.3);
    simulateClick(optionEls[chosenIndex]);
    await delay(speed * 0.5);
  }
  return true;
}
