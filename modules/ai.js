// modules/ai.js
// Sends a prompt to Gemini via the background service worker.

/**
 * Ask Gemini AI a question, optionally with an image. Returns the answer string.
 * @param {string} prompt
 * @param {string|null} imageBase64
 * @returns {Promise<string>}
 */
export async function askAI(prompt, imageBase64 = null) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiKey"], ({ apiKey }) => {
      if (!apiKey) {
        resolve("");
        return;
      }
      chrome.runtime.sendMessage({ type: "ASK_AI", prompt, apiKey, imageBase64 }, (resp) => {
        if (chrome.runtime.lastError || !resp) { resolve(""); return; }
        if (resp.error) {
          console.warn("AI Error:", resp.error);
          resolve(JSON.stringify({ error: resp.error }));
          return;
        }
        resolve(resp.text || "");
      });
    });
  });
}

/**
 * Build a prompt that asks AI to pick the best answer option.
 * @param {string} question
 * @param {string[]} options  Array of option label strings
 * @returns {Promise<number>} Zero-based index of the best option
 */
export async function pickBestOption(question, options) {
  const numbered = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  const prompt = `You are helping a student answer a multiple choice question correctly.
Question: ${question}
Options:
${numbered}

Reply with ONLY the number of the correct answer (e.g. "2"). No explanation.`;
  const ans = await askAI(prompt);
  const n = parseInt(ans, 10);
  if (!isNaN(n) && n >= 1 && n <= options.length) return n - 1;
  return 0; // fallback to first option
}

/**
 * Ask AI to generate a short answer for a fill-in-the-blank question.
 * @param {string} question
 * @param {string} [context]
 * @returns {Promise<string>}
 */
export async function generateAnswer(question, context = "") {
  const prompt = `You are answering a student fill-in-the-blank or short answer question.
${context ? "Context: " + context + "\n" : ""}Question: ${question}

Reply with ONLY the answer text, as concise as possible (a word, phrase, or short sentence). No explanation.`;
  return await askAI(prompt);
}

/**
 * Ask AI to generate code for a coding lab.
 * @param {string} problemStatement
 * @param {string} [language]
 * @returns {Promise<string>}
 */
export async function generateCode(problemStatement, language = "python") {
  const prompt = `You are completing a coding lab exercise.
Language: ${language}
Problem:
${problemStatement}

Reply with ONLY the complete, correct code. No markdown fences, no explanation.`;
  return await askAI(prompt);
}
