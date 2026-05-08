<div align="center">
  <a href="https://readest.com" target="_blank">
    <img src="https://github.com/readest/readest/blob/main/apps/readest-app/src-tauri/icons/icon.png?raw=true" alt="Readest Logo" width="20%" />
  </a>
  <h1>Readest — AI Edition</h1>
  <p><i>Fork of Readest with AI-powered inline text explanation</i></p>
  <br>

[![OS][badge-platforms]][link-website]
[![AGPL Licence][badge-license]](LICENSE)
[![Latest release][badge-release]][link-gh-releases]

</div>

<p align="center">
  <a href="#-features">Features</a> •
  <a href="#-ai-explanation-feature">AI Explanation</a> •
  <a href="#%EF%B8%8F-how-it-works">How It Works</a> •
  <a href="#-getting-started">Getting Started</a> •
  <a href="#-ai-provider-setup">AI Provider Setup</a>
</p>

---

## ✨ Features

This fork builds upon [Readest](https://github.com/readest/readest) — an open-source ebook reader built with Next.js 16 and Tauri v2 — and adds **AI-powered inline text explanation**.

| Feature                        | Description                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| **🧠 AI Explain on Selection** | Select any text in a book and click the brain icon to get an instant AI explanation |
| **🤖 Notebook AI Chat**        | Chat with AI about the book content with RAG context from indexed books             |
| **📚 Multiple AI Providers**   | Supports Ollama (local), DeepSeek / OpenAI-compatible (cloud), and AI Gateway       |
| **⚡ Streaming Responses**     | Real-time streaming of AI responses for a smooth reading experience                 |
| **💾 Explanation Caching**     | Previously explained texts are cached locally for instant retrieval                 |
| **📖 RAG Context**             | When the book is indexed, AI explanations include context from surrounding passages |
| **🎨 Markdown Rendering**      | AI responses support rich Markdown formatting via react-markdown                    |

## 🧠 AI Explanation Feature

The core addition is the **inline AI explain** feature:

1. Open any book in Readest
2. Select a word, phrase, or passage with your cursor
3. Click the **🧠 Explain** button that appears in the selection toolbar
4. An AI explanation popup shows the result with streaming text

The popup supports:

- **Copy** the explanation to clipboard
- **Regenerate** to get a new explanation
- **Context references** showing the number of passages used from the book

### ⚙️ How It Works

```
User selects text → Selection toolbar with 🧠 btn appears
         ↓
Click 🧠 → ExplainPopup opens
         ↓
    ┌─ Check local cache (IndexedDB) ── hit → show cached result
    │  miss
    ↓
    ┌─ RAG search (if book indexed) → get relevant passages
    │
    ↓
    ┌─ Build system prompt with instructions + context
    │
    ↓
    ┌─ Stream response from AI provider via SSE
    │   (Ollama: NDJSON, DeepSeek: SSE)
    ↓
    └─ Cache result → Show Markdown-rendered explanation
```

## 🛠 Getting Started

### Prerequisites

- **Node.js** v20+ and **pnpm** (for Next.js frontend)
- **Rust** and **Cargo** (for building Tauri desktop app)
- **Visual Studio Build Tools** with "Desktop development with C++" (Windows only)

```bash
# Install pnpm globally
npm install -g pnpm
```

### Clone & Build

```bash
# Clone with AI explain feature branch
git clone -b feature/ai-selection-actions https://github.com/biechouwo-coder/readest.git
cd readest

# Install dependencies
git submodule update --init --recursive
pnpm install
pnpm --filter @readest/readest-app setup-vendors

# Build for development (Web)
pnpm dev-web

# Build for production (Desktop)
pnpm tauri build
```

The built executable will be at `target/release/readest.exe` (Windows) or the corresponding path for your platform.

## 🔌 AI Provider Setup

### Option 1: Ollama (Local, Free)

1. Install [Ollama](https://ollama.com)
2. Pull a model: `ollama pull llama3.2`
3. In Readest: **Settings → AI Assistant → Enable → Ollama**
4. Default URL: `http://127.0.0.1:11434`

### Option 2: DeepSeek (Cloud, Cheap API)

1. Get an API key from [platform.deepseek.com](https://platform.deepseek.com)
2. In Readest: **Settings → AI Assistant → Enable → OpenAI Compatible**
3. Base URL: `https://api.deepseek.com`
4. Model: `deepseek-chat` (or your custom model)
5. Embedding Model: `deepseek-embedding` (optional, for RAG)
6. API Key: Your DeepSeek API key

### Option 3: AI Gateway (Cloud)

Supports Vercel AI Gateway with models like Gemini, GPT, Claude, etc.

### Configure in Settings

Open Readest → Click ⚙️ Settings → **AI Assistant** tab:

- Toggle **Enable AI Assistant**
- Select provider
- Enter API key / model info
- Click **Test Connection** to verify

## 📁 Modified Files

| File                                                      | Change                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `src/types/annotator.ts`                                  | Added `'explain'` to `AnnotationToolType`                      |
| `src/app/reader/components/annotator/AnnotationTools.tsx` | Added 🧠 Explain button with `PiBrain` icon                    |
| `src/app/reader/components/annotator/Annotator.tsx`       | Added `handleExplain` handler, popup state & rendering         |
| `src/app/reader/components/annotator/ExplainPopup.tsx`    | **New** — AI explain popup with SSE streaming, RAG, caching    |
| `src/services/ai/adapters/TauriChatAdapter.ts`            | Refactored to use direct fetch + SSE (no API route dependency) |

## 📄 License

This project is licensed under the **GNU Affero General Public License v3.0** — see the [LICENSE](LICENSE) file for details.

The original Readest project is by the [Readest team](https://github.com/readest/readest).

---

<p align="center"><b>Happy reading with AI! 📖🤖</b></p>

[badge-license]: https://img.shields.io/github/license/readest/readest?color=teal
[badge-release]: https://img.shields.io/github/release/readest/readest?color=green
[badge-platforms]: https://img.shields.io/badge/platforms-macOS%2C%20Windows%2C%20Linux%2C%20Android%2C%20iOS%2C%20Web%2C%20PWA-green
[link-website]: https://readest.com
[link-gh-releases]: https://github.com/readest/readest/releases
