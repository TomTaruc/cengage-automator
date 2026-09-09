// background.js — Service Worker
// Handles AI calls (avoids CORS issues in content scripts), stores settings.

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ASK_AI") {
    handleAI(msg.prompt, msg.apiKey).then(sendResponse);
    return true; // keep channel open for async
  }
  if (msg.type === "GET_SETTINGS") {
    chrome.storage.sync.get(["apiKey","speed","enabled"], (data) => sendResponse(data));
    return true;
  }
});

async function handleAI(prompt, apiKey) {
  if (!apiKey) return { error: "No API key" };
  try {
    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
      })
    });
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { text: text.trim() };
  } catch (e) {
    return { error: e.message };
  }
}
