# ReviewLens — AI Amazon Review Analyzer

> A Chrome/Edge extension that scrapes Amazon product reviews, surfaces instant stats, and lets you have a real conversation with them — powered by Google Gemini.

![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-MV3-4285F4?style=flat-square&logo=googlechrome&logoColor=white)
![Gemini API](https://img.shields.io/badge/Gemini-2.5%20Flash-8E75B2?style=flat-square&logo=google&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)

---

## What it does

Open any Amazon product page. ReviewLens injects a sidebar that:

- **Auto-scrapes** up to 1 000 reviews in the background (no clicking, no waiting)
- **Shows live stats** — overall rating, star breakdown, date range — the moment page 1 loads
- **Generates an AI summary** of the full review corpus with a single click
- **Answers natural-language questions** grounded in real review text, with clickable links to the exact reviews it cites
- **Handles follow-ups** — ask "give me links to that" or "what about the 1-star ones?" and it knows what you mean

---

## Demo

| Stats + Summary | AI Q&A |
|---|---|
| Instant rating breakdown, shimmer skeleton while loading | Ask anything — the LLM searches reviews and streams back a cited answer |

---

## Architecture

```
Amazon Product Page
       │
       ├─ content/scraper.js        Fetches /product-reviews/ pages with 300ms
       │                            delay, auto-paginates up to 100 pages (1 000
       │                            reviews), saves to chrome.storage.local
       │
       ├─ content/sidebar.js        Injects the panel iframe into the page
       │
       └─ sidebar/panel.js          Main UI — polls storage, renders stats,
                                    drives all AI calls via the proxy

AI Pipeline (two-phase RAG)
       │
       ├─ Phase 1 — Keyword selection
       │   Sends a compact snapshot (one line per review: rating + title) to
       │   gemini-2.5-flash with tool_config mode:ANY, forcing it to call
       │   search_reviews({query, max_results}). The tool runs locally with
       │   prefix/stem keyword matching — no extra API call.
       │
       └─ Phase 2 — Streaming answer
           Full text of matched reviews (+ permalink URLs) is passed as context
           to gemini-2.5-flash-lite, which streams a cited markdown answer
           back through a Cloudflare Worker via Server-Sent Events.

Proxy (Cloudflare Worker)
       │
       ├─ /chat   Routes to generateContent (tool calls) or streamGenerateContent
       │          (SSE answers) based on whether the request includes tools
       │
       └─ Rate limiting via Upstash Redis — per-IP daily caps
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Extension | Chrome MV3, Manifest V3 service worker |
| Scraping | Fetch API + DOMParser, 300 ms page delay |
| AI — tool phase | Gemini 2.5 Flash, function calling (`mode: ANY`) |
| AI — answer phase | Gemini 2.5 Flash-Lite, streaming SSE |
| Proxy | Cloudflare Workers (Edge, zero cold-start) |
| Rate limiting | Upstash Redis (serverless Redis) |
| Storage | `chrome.storage.local` (persists across sidebar opens) |
| UI | Vanilla JS, custom dark design system, CSS animations |

---

## Key Engineering Decisions

**Why `mode: ANY` (forced tool calling)?**
With `mode: AUTO`, Gemini occasionally answered directly from review titles in the compact snapshot — hallucinating quotes and providing zero links. Forcing a tool call every time guarantees the LLM fetches real review text before answering.

**Two-layer context instead of pure RAG**
The compact snapshot (one line per review) gives the LLM full distribution awareness — it can say "62% of reviews mention X" accurately. The tool-fetched full text gives depth and exact quotes. Neither alone is sufficient.

**Conversation continuity without chat history in API calls**
`mode: ANY` rejects plain-text model turns in the message array. Instead, the last 4 conversation turns are injected as text inside the system prompt so the LLM understands follow-up questions without breaking the tool-calling contract.

**Auto-pagination with live progress**
The scraper runs entirely inside the content script — no background service worker round-trips for each page. `chrome.storage.onChanged` lets the sidebar react to each batch of new reviews as they arrive, updating the count chip and progress pill in real time.

---

## Project Structure

```
reviewlens/
├── extension/
│   ├── manifest.json
│   ├── assets/               Extension icons
│   ├── background/
│   │   └── service-worker.js Tab registry for cross-context messaging
│   ├── content/
│   │   ├── scraper.js        Review scraper + auto-paginator
│   │   └── sidebar.js        Iframe injector
│   ├── lib/
│   │   └── prompts.js        All LLM system prompts
│   └── sidebar/
│       ├── panel.html        Sidebar shell
│       ├── panel.css         Dark design system
│       └── panel.js          UI logic + AI pipeline orchestration
└── proxy/
    ├── worker.js             Cloudflare Worker — Gemini proxy + rate limiting
    └── wrangler.toml         Cloudflare deployment config
```

---

## Getting Started

### Prerequisites

- Chrome or Edge (any recent version)
- A [Google AI Studio](https://aistudio.google.com/) API key (Gemini)
- A [Cloudflare](https://workers.cloudflare.com/) account (free tier is enough)
- A [Upstash](https://upstash.com/) Redis database (free tier is enough)

### 1 — Deploy the proxy

```bash
cd proxy
npm install -g wrangler
wrangler secret put GEMINI_API_KEY        # your Gemini key
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler deploy
```

Copy the deployed worker URL (e.g. `https://amazon-review-proxy.yourname.workers.dev`).

### 2 — Configure the extension

Open `extension/sidebar/panel.js` and update line 3:

```js
const WORKER_URL = 'https://your-worker-url.workers.dev';
```

### 3 — Load the extension

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 4 — Use it

Navigate to any Amazon product page (e.g. `amazon.com/dp/B08N5WRWNW`). The ReviewLens panel opens automatically on the right side.

---

## Features

- **Live scraping progress** — "Loading reviews: 340 of ~1 000" pill updates in real time
- **Shimmer skeleton** — layout preview while page 1 loads
- **AI Summary** — streams a structured breakdown of the full review corpus
- **Smart suggestions** — auto-generated questions based on keywords detected in reviews
- **Follow-up detection** — short/contextual questions reuse the previous search context (no redundant API calls)
- **Rating filter** — narrow Q&A to 1–2★ or 4–5★ reviews
- **Clickable review links** — every cited review links to its Amazon permalink
- **Dark UI** — custom design system with gradient accent, smooth animations

---

## License

MIT © Anas
