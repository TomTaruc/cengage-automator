# 🤖 Cengage MindTap Automator

A Chrome browser extension that automates **Cengage MindTap** labs, quizzes, coding exercises, and step-through simulations using **Google Gemini AI**.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-green)
![Gemini AI](https://img.shields.io/badge/AI-Gemini%201.5%20Flash-orange)

---

## ✨ Features

| Activity Type | What it does |
|---|---|
| **Multiple Choice / T-F** | Sends question + options to Gemini AI → selects the best answer |
| **Fill-in-the-blank** | Extracts question → AI generates answer → types it with native event simulation |
| **Coding Labs** | Detects CodeMirror/Monaco/Ace editors → AI writes code → injects it |
| **Lab Simulations** | Reads each step instruction → AI identifies which element to click |
| **Navigation** | Auto-clicks Next / Submit / Check Answer / Continue buttons |

---

## 📦 Installation

1. **Clone or download** this repository
2. Open Chrome → go to `chrome://extensions`
3. Enable **Developer Mode** (top-right toggle)
4. Click **"Load unpacked"** → select the `cengage-automator` folder
5. The robot icon 🤖 will appear in your Chrome toolbar

---

## 🔑 Setup

1. Get a **free Gemini API key** from [aistudio.google.com](https://aistudio.google.com)
2. Click the extension icon → paste the API key in the popup
3. Set your preferred speed (Slow / Medium / Fast)

---

## 🚀 Usage

1. Navigate to your **MindTap activity page** in Chrome
2. Click the 🤖 extension icon → popup opens with **"✓ MindTap detected"**
3. Click **START** — automation runs until the assignment is complete

### Controls

| Button | Action |
|---|---|
| **START** | Full automation — runs to completion |
| **STOP** | Stop at any time |
| **STEP** | Answer current page only, then click Next |

---

## 📁 File Structure

```
cengage-automator/
├── manifest.json          ← Chrome MV3 config
├── background.js          ← Service worker (Gemini API calls)
├── content.js             ← Main automation script (injected into MindTap)
├── modules/
│   ├── detector.js        ← Detects activity type
│   ├── mcq.js             ← Multiple choice handler
│   ├── fillin.js          ← Fill-in-the-blank handler
│   ├── lab.js             ← Lab simulation handler
│   ├── coding.js          ← Coding lab handler (CodeMirror/Monaco/Ace)
│   ├── navigator.js       ← Next/Submit button handler
│   ├── ai.js              ← Gemini AI interface
│   └── utils.js           ← Shared utilities
├── popup/
│   ├── popup.html         ← Dark-mode control panel
│   ├── popup.css          ← Glassmorphism styling
│   └── popup.js           ← Popup logic
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## 🛠 How It Works

```
Page loads → content.js detects activity type
           → delegates to correct handler module
           → AI answers the question
           → navigator clicks Next/Submit
           → repeats until assignment is complete
```

The extension uses **Gemini 1.5 Flash** (fast, free tier) for all AI decisions. Your API key is stored encrypted in Chrome's `storage.sync` and is only ever sent directly to the Gemini API.

---

## ⚠️ Disclaimer

This tool is for personal use and learning assistance. Use it responsibly and in accordance with your institution's academic integrity policies.
