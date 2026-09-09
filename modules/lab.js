// modules/lab.js
// Handles step-through lab simulations in MindTap.
// Reads the current instruction text and clicks the correct element.

import { askAI } from "./ai.js";
import { delay } from "./utils.js";

const INSTRUCTION_SELECTORS = [
  "[class*='lab-step']",
  "[class*='step-instruction']",
  "[class*='lab-instruction']",
  "[class*='task-description']",
  "[class*='activity-instruction']",
  "[class*='step-text']",
  "[class*='instruction-text']",
  ".instruction",
  ".task",
  ".step"
];

const NEXT_STEP_SELECTORS = [
  "button[class*='next']",
  "button[class*='continue']",
  "button[class*='proceed']",
  "button[class*='submit']",
  "[class*='step-btn']",
  "[class*='next-step']"
];

/**
 * Get the current lab step instruction text.
 */
function getStepInstruction() {
  for (const sel of INSTRUCTION_SELECTORS) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim()) return el.innerText.trim();
  }
  return "";
}

/**
 * Collect all interactive elements on the page and describe them.
 * Returns an array of {element, description} objects.
 */
function collectInteractables() {
  const tags = ["button", "a", "input", "select", "textarea", "[role='button']",
                "[role='tab']", "[role='menuitem']", "[role='link']",
                "[class*='btn']", "[class*='clickable']", "[class*='selectable']"];
  const els = [...document.querySelectorAll(tags.join(","))];
  return els
    .filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .map((el, i) => ({
      index: i,
      element: el,
      description: [
        el.innerText?.trim(),
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("value"),
        el.getAttribute("placeholder"),
        el.tagName.toLowerCase(),
        el.className.slice(0, 60)
      ].filter(Boolean).join(" | ").slice(0, 120)
    }))
    .filter(d => d.description.trim().length > 0);
}

/**
 * Use AI to identify which element to click for the current step.
 */
async function identifyTarget(instruction, interactables) {
  if (!instruction || interactables.length === 0) return null;

  const elList = interactables
    .slice(0, 30) // Cap to avoid huge prompts
    .map(d => `${d.index}: ${d.description}`)
    .join("\n");

  const prompt = `You are helping automate a lab simulation step.

Current instruction: "${instruction}"

Available interactive elements (index: description):
${elList}

Which element index should be clicked to complete this step?
Reply with ONLY the number (e.g. "5"). If none match, reply "none".`;

  const result = await askAI(prompt);
  const n = parseInt(result, 10);
  if (!isNaN(n) && interactables[n]) return interactables[n].element;
  return null;
}

/**
 * Check if a "Next Step" / "Continue" button is present and click it.
 */
async function clickNextStep(speed) {
  for (const sel of NEXT_STEP_SELECTORS) {
    const btn = document.querySelector(sel);
    if (btn && !btn.disabled) {
      await delay(speed * 0.5);
      btn.click();
      return true;
    }
  }
  return false;
}

/**
 * Run through lab steps. Loops until no more steps found.
 */
export async function handleLab(speed = 1500, maxSteps = 60) {
  let stepsDone = 0;
  let lastInstruction = "";

  while (stepsDone < maxSteps) {
    await delay(speed);

    const instruction = getStepInstruction();
    if (!instruction) {
      console.log("[Automator] Lab: No instruction found, stopping.");
      break;
    }

    // Avoid re-doing same step
    if (instruction === lastInstruction) {
      console.warn("[Automator] Lab: Instruction unchanged after action, may be stuck.");
      // Try clicking the next-step button anyway
      const advanced = await clickNextStep(speed);
      if (!advanced) break;
      stepsDone++;
      continue;
    }

    console.log(`[Automator] Lab step ${stepsDone + 1}: "${instruction.slice(0, 100)}"`);
    lastInstruction = instruction;

    const interactables = collectInteractables();
    const target = await identifyTarget(instruction, interactables);

    if (target) {
      console.log("[Automator] Lab: Clicking identified target:", target.innerText || target.className);
      await delay(speed * 0.3);
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      await delay(300);
      target.click();
    } else {
      console.warn("[Automator] Lab: No target identified, trying Next Step button.");
    }

    await delay(speed * 0.5);
    await clickNextStep(speed * 0.5);
    stepsDone++;
  }

  console.log(`[Automator] Lab complete. ${stepsDone} steps done.`);
  return true;
}
