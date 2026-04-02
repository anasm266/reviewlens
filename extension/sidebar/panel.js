import { chatSystemPrompt, gatherPrompt, summaryPrompt, SUMMARY_USER_MESSAGE } from '../lib/prompts.js';

const WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev'; // replace with your deployed Worker URL
const POLL_INTERVAL = 500;
const POLL_TIMEOUT  = 15000;

// ── State ────────────────────────────────────────────────────────────────────
let asin = null;
let reviews = [];
let productName = '';     // full product title, passed to every AI prompt
let chatHistory = [];
let ratingFilter = 'all';
let isChatting = false;
let lastSearchedReviews = []; // cached context for follow-up questions

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const loadingState  = $('loading-state');
const errorState    = $('error-state');
const errorMsg      = $('error-msg');
const mainEl        = $('main');
const inputBar      = $('input-bar');
const productTitle  = $('product-title');
const totalCount    = $('total-count');
const overallRating = $('overall-rating');
const starsDisplay  = $('stars-display');
const dateRange     = $('review-date-range');
const breakdown     = $('breakdown');
const summaryContent= $('summary-content');
const genSummaryBtn = $('gen-summary-btn');
const refreshSumBtn = $('refresh-summary-btn');
const suggestionsEl = $('suggestions');
const messagesEl    = $('messages');
const chatInput     = $('chat-input');
const sendBtn       = $('send-btn');
const loadProgress  = $('load-progress');
const loadProgressText = $('load-progress-text');

// ── Keyword → suggestion map ─────────────────────────────────────────────────
const KEYWORD_MAP = [
  { words: ['size','fit','small','large','tight','loose'],  q: 'Does it run true to size?' },
  { words: ['break','broke','quality','cheap','flimsy'],    q: 'Is the build quality good?' },
  { words: ['return','refund','sent back'],                 q: 'Why do people return this?' },
  { words: ['smell','odor','stink'],                        q: 'Do reviewers mention any smell?' },
  { words: ['battery','charge','charging'],                 q: 'How is the battery life?' },
  { words: ['easy','instructions','setup','assemble'],      q: 'Is it easy to set up?' },
  { words: ['noise','loud','quiet','sound'],                q: 'How noisy is it?' },
  { words: ['durable','last','lasting','years'],            q: 'Is it durable long-term?' },
];
const GENERIC_SUGGESTIONS = [
  "What do most reviewers love about this?",
  "What are the biggest complaints?",
  "Is it worth the price?",
  "Did review quality change over time?",
];

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  asin = new URLSearchParams(window.location.search).get('asin');
  if (!asin) { showError('Could not detect product ASIN.'); return; }

  // Wait for at least page 1 of reviews
  const data = await pollForData();
  if (!data) { showError('Could not load reviews. Try refreshing the page.'); return; }
  if (data.captcha) { showError('Amazon showed a CAPTCHA. Please refresh the product page and try again.'); return; }

  applyData(data);
  showMain();

  // Watch for ongoing scrape updates (pages 2–10 arriving in background)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const key = `rl_scrape_${asin}`;
    if (!changes[key]) return;
    const newData = changes[key].newValue;
    if (!newData) return;
    applyData(newData, /* isUpdate */ true);
  });
}

function applyData(data, isUpdate = false) {
  const incoming = data.reviews || [];

  // Only re-render stats on first load or if review count changed
  if (!isUpdate || incoming.length !== reviews.length) {
    reviews = incoming;
    updateCountChip(data);
    updateLoadProgress(data);

    refreshDateRange();   // always recompute from the full reviews array

    if (!isUpdate) {
      renderAll(data.stats);
    } else {
      totalCount.textContent = `${reviews.length} review${reviews.length !== 1 ? 's' : ''} loaded`;
    }
  }
}

function updateCountChip(data) {
  totalCount.textContent = `${data.reviews?.length || 0} review${data.reviews?.length !== 1 ? 's' : ''} loaded`;
}

function refreshDateRange() {
  if (reviews.length === 0) return;
  const dates = reviews
    .map(r => parseReviewDate(r.date))
    .filter(Boolean)
    .sort((a, b) => a - b);
  if (dates.length === 0) return;
  const start = fmtDate(dates[0]);
  const end   = fmtDate(dates[dates.length - 1]);
  dateRange.textContent = start === end ? start : `${start} – ${end}`;
}

function updateLoadProgress(data) {
  if (data.status === 'loading') {
    const loaded = data.reviews?.length || 0;
    const total = data.totalPages ? data.totalPages * 10 : '?';
    loadProgressText.textContent = `Loading reviews: ${loaded} of ~${total}`;
    loadProgress.classList.remove('hidden');
  } else {
    loadProgress.classList.add('hidden');
  }
}

// Poll chrome.storage.local until scraper writes first-page data (or timeout)
function pollForData() {
  return new Promise((resolve) => {
    const key = `rl_scrape_${asin}`;
    const start = Date.now();
    const check = () => {
      chrome.storage.local.get(key, (items) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        const d = items[key];
        if (d && d.reviews) { resolve(d); return; }
        if (Date.now() - start > POLL_TIMEOUT) { resolve(null); return; }
        setTimeout(check, POLL_INTERVAL);
      });
    };
    check();
  });
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderAll(stats) {
  if (!stats) return;

  productName = stats.productTitle || '';
  productTitle.textContent = productName;

  const count = reviews.length;
  totalCount.textContent = `${count} review${count !== 1 ? 's' : ''} loaded`;

  // Overall rating
  const ratingNum = parseFloat(stats.overallRating);
  if (!isNaN(ratingNum)) {
    overallRating.textContent = ratingNum.toFixed(1);
    starsDisplay.textContent = starsFromRating(ratingNum);
  }

  // Star breakdown bars
  renderBreakdown(stats.breakdown || []);

  // Summary — load from cache if available
  const cached = localStorage.getItem(`rl_summary_${asin}`);
  if (cached) renderSummaryText(cached);

  // Suggestions
  renderSuggestions();
}

function renderBreakdown(bArr) {
  breakdown.innerHTML = '';
  const parsed = bArr
    .map(t => {
      const m = t.match(/(\d)\s*star[s]?\s+(\d+)%/i) || t.match(/(\d)\s*[\u2605★]\s*(\d+)%/i);
      return m ? { stars: parseInt(m[1]), pct: parseInt(m[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.stars - a.stars);

  parsed.forEach(({ stars, pct }, index) => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.style.setProperty('--bar-index', index);
    row.innerHTML = `
      <span class="bar-label">${stars}★</span>
      <div class="bar-track"><div class="bar-fill" style="--bar-w:${pct}%"></div></div>
      <span class="bar-pct">${pct}%</span>`;
    breakdown.appendChild(row);
  });
}

function renderSuggestions() {
  suggestionsEl.innerHTML = '';
  const allText = reviews.map(r => (r.text + ' ' + r.title).toLowerCase()).join(' ');
  const shown = new Set();
  const qs = [];

  for (const { words, q } of KEYWORD_MAP) {
    if (qs.length >= 6) break;
    if (words.some(w => allText.includes(w)) && !shown.has(q)) {
      qs.push(q);
      shown.add(q);
    }
  }

  if (qs.length < 4) {
    for (const g of GENERIC_SUGGESTIONS) {
      if (qs.length >= 6) break;
      if (!shown.has(g)) { qs.push(g); shown.add(g); }
    }
  }

  for (const q of qs) {
    const chip = document.createElement('button');
    chip.className = 'suggestion-chip';
    chip.textContent = q;
    chip.addEventListener('click', () => handleQuestion(q));
    suggestionsEl.appendChild(chip);
  }
}

function renderSummaryText(text) {
  summaryContent.innerHTML = '';
  const div = document.createElement('div');
  div.id = 'summary-text';
  div.innerHTML = markdownToHtml(text);
  summaryContent.appendChild(div);
  refreshSumBtn.classList.remove('hidden');
}

function showMain() {
  loadingState.classList.add('hidden');
  mainEl.classList.remove('hidden');
  inputBar.classList.remove('hidden');
}

function showError(msg) {
  loadingState.classList.add('hidden');
  errorMsg.textContent = msg;
  errorState.classList.remove('hidden');
}

// ── Summary ──────────────────────────────────────────────────────────────────
async function generateSummary(force = false) {
  const cacheKey = `rl_summary_${asin}`;
  if (!force && localStorage.getItem(cacheKey)) return;

  genSummaryBtn && (genSummaryBtn.disabled = true);
  genSummaryBtn && (genSummaryBtn.textContent = 'Generating…');

  // Truncate reviews text to ~25000 tokens (~100000 chars, ~330 reviews)
  const MAX_CHARS = 100000;
  let reviewsText = reviews.map((r, i) =>
    `[${i + 1}] ★${r.rating} ${r.verified ? '(verified)' : ''} ${r.date}\n${r.title ? r.title + '. ' : ''}${r.text}`
  ).join('\n\n');
  if (reviewsText.length > MAX_CHARS) reviewsText = reviewsText.slice(0, MAX_CHARS) + '…';

  const sysPrompt = summaryPrompt(reviewsText);
  const messages = [{ role: 'user', content: SUMMARY_USER_MESSAGE }];

  // Show streaming placeholder
  summaryContent.innerHTML = '<div id="summary-text" class="typing-cursor"></div>';
  const summaryEl = $('summary-text');
  let fullText = '';

  try {
    await streamChat(messages, sysPrompt,
      chunk => {
        fullText += chunk;
        summaryEl.textContent = fullText;
      },
      () => {
        summaryEl.classList.remove('typing-cursor');
        summaryEl.innerHTML = markdownToHtml(fullText);
        localStorage.setItem(cacheKey, fullText);
        refreshSumBtn.classList.remove('hidden');
      },
      err => {
        summaryEl.classList.remove('typing-cursor');
        summaryEl.textContent = `Error: ${err}`;
      }
    );
  } finally {
    if (genSummaryBtn) {
      genSummaryBtn.disabled = false;
      genSummaryBtn.textContent = 'Generate Summary';
    }
  }
}

// ── Keyword search (local, no API) ───────────────────────────────────────────
function keywordSearch(query, reviewList, maxResults = 20, filter = 'all') {
  const terms = (query.toLowerCase().match(/\b\w{3,}\b/g) || []);
  if (terms.length === 0) return [];

  let pool = reviewList;
  if (filter === '1-2') pool = reviewList.filter(r => parseFloat(r.rating) <= 2);
  else if (filter === '4-5') pool = reviewList.filter(r => parseFloat(r.rating) >= 4);

  return pool
    .map(r => {
      const haystack = ((r.title || '') + ' ' + (r.text || '')).toLowerCase();
      const score = terms.reduce((sum, t) => {
        // Prefix/stem match: \b + term (no trailing \b) so "build" hits "built","building" etc.
        const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        return sum + (haystack.match(re) || []).length;
      }, 0);
      return { r, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(x => x.r);
}

// ── Compact snapshot — one line per review for full-picture context ──────────
// Gives the LLM the full rating distribution and all titles without the token
// cost of full review bodies. Capped at 1000 entries for latency.
function buildCompactSnapshot(reviewList) {
  const MAX = 1000;
  const list = reviewList.length > MAX ? reviewList.slice(0, MAX) : reviewList;
  const header = reviewList.length > MAX
    ? `(showing ${MAX} of ${reviewList.length} reviews)\n`
    : '';
  return header + list
    .map((r, i) =>
      `[${i + 1}] ★${parseFloat(r.rating).toFixed(1)}${r.verified ? '✓' : ''} | ${r.date} | ${r.title || '(no title)'}`
    )
    .join('\n');
}

// ── Follow-up detection — reuse last search context for short contextual questions ──
function isFollowUp(question) {
  if (chatHistory.length === 0) return false;
  const q = question.toLowerCase().trim();
  const wordCount = q.split(/\s+/).length;
  // Very short questions (≤3 words) with prior history are almost always contextual
  if (wordCount <= 3) return true;
  // Medium questions: require a prior search cached AND a reference word
  return (
    wordCount <= 8 &&
    lastSearchedReviews.length > 0 &&
    /\b(that|those|full|link|links|url|exact|exactly|the review|which|it|them|the one|date|text|show|give me|more|those reviews)\b/.test(q)
  );
}

// ── Chat ──────────────────────────────────────────────────────────────────────
async function handleQuestion(question) {
  if (isChatting || !question.trim()) return;

  chatInput.value = '';
  autoResizeInput();
  addMessage('user', question);

  if (reviews.length === 0) {
    addMessage('assistant', 'No reviews were loaded for this product. Try refreshing the page.');
    return;
  }

  if (reviews.length < 100) {
    showSystemMessage(`Only ${reviews.length} reviews loaded so far — more arriving in the background. This answer may improve once all reviews are in.`);
  }

  isChatting = true;
  sendBtn.disabled = true;

  const assistantEl = addMessage('assistant', '');
  const bubble = assistantEl.querySelector('.msg-bubble');
  bubble.classList.add('typing-cursor');

  try {
    const followUp = isFollowUp(question);

    // Compact snapshot: rating + title for every review — gives the LLM the full
    // distribution picture and helps it pick better search keywords.
    const compactSnapshot = buildCompactSnapshot(reviews);

    // Recent conversation injected as text into the gather system prompt so the
    // LLM understands follow-up questions. Can't use message turns here because
    // mode:ANY rejects any plain-text model turns in the conversation.
    const recentContext = chatHistory.length
      ? chatHistory.slice(-4).map(m =>
          `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`
        ).join('\n')
      : '';

    // Reviews collected via tool calls, keyed by array index for deduplication.
    const foundMap = new Map();

    // ── Phase 1: AI-driven search (skipped for follow-ups) ───────────────────
    if (!followUp) {
      // Show progress immediately so the UI feels responsive
      bubble.textContent = '';
      const searchBadge = document.createElement('div');
      searchBadge.className = 'rag-badge';
      searchBadge.innerHTML =
        `<span class="rag-icon">🔍</span> <span id="search-status">Searching reviews…</span>`;
      assistantEl.appendChild(searchBadge);

      // mode:ANY — LLM must always call this tool (titles alone aren't enough
      // to answer content questions; full review text is required).
      const toolDef = {
        name: 'search_reviews',
        description: 'Fetch full review text matching keywords. Always call this to get real review content.',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Space-separated consumer-vocabulary keywords (e.g. "broke stopped working cheap")',
            },
            max_results: {
              type: 'INTEGER',
              description: 'Max reviews to return (default 20, max 40)',
            },
          },
          required: ['query'],
        },
      };

      // Only the current question — mode:ANY rejects plain-text model turns.
      // Conversation context is passed via the system prompt (recentContext) instead.
      const baseMessages = [{ role: 'user', content: question, parts: [{ text: question }] }];
      const toolTurns = []; // accumulates function-call ↔ function-response pairs

      for (let iter = 0; iter < 2; iter++) {
        const result = await callWithTool(
          [...baseMessages, ...toolTurns],
          gatherPrompt(compactSnapshot, reviews.length, productName, recentContext),
          toolDef
        );

        if (!result || result.type !== 'call') break; // error or unexpected text response

        // LLM called the tool — run keyword search locally (no extra API call)
        const { name, args } = result;
        const maxR = Math.min(args.max_results || 20, 40);
        const found = keywordSearch(args.query, reviews, maxR, ratingFilter);
        found.forEach(r => {
          const i = reviews.indexOf(r);
          if (i !== -1) foundMap.set(i, r);
        });

        // Update badge with live search status
        const statusEl = assistantEl.querySelector('#search-status');
        if (statusEl) statusEl.textContent = `"${args.query}" · ${foundMap.size} found`;

        // Append this tool call + its result so the next iteration has full context
        toolTurns.push({ role: 'model', parts: [{ functionCall: { name, args } }] });
        toolTurns.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name,
              response: {
                total_found: found.length,
                total_reviews: reviews.length,
                reviews: found.map(r => {
                  const url = r.reviewId
                    ? `https://www.amazon.com/gp/customer-reviews/${r.reviewId}/`
                    : null;
                  return (
                    `★${r.rating} ${r.verified ? '(verified)' : ''} | ${r.date}` +
                    `${url ? ` | ${url}` : ''}\n` +
                    `${r.title ? r.title + '. ' : ''}${r.text}`
                  );
                }),
              },
            },
          }],
        });
      }

      assistantEl.querySelectorAll('.rag-badge').forEach(b => b.remove());
    }

    // ── Phase 2: stream the answer ────────────────────────────────────────────
    // Follow-ups reuse the last search; fresh questions use tool results.
    let uniqueReviews = followUp ? lastSearchedReviews : [...foundMap.values()];

    // Fallback: if no tool results, keyword-search the raw question
    if (uniqueReviews.length === 0) {
      uniqueReviews = keywordSearch(question, reviews, 40, ratingFilter);
    }
    // Cache so the next follow-up can skip the search phase entirely
    if (uniqueReviews.length > 0 && !followUp) lastSearchedReviews = uniqueReviews;

    if (uniqueReviews.length === 0) {
      bubble.classList.remove('typing-cursor');
      bubble.textContent = 'No reviews match the current filter. Try switching to "All reviews".';
      return;
    }

    // Full review text for depth (includes URLs so the LLM can produce links)
    const detailedContext = uniqueReviews
      .map(r => {
        const url = r.reviewId
          ? `https://www.amazon.com/gp/customer-reviews/${r.reviewId}/`
          : null;
        return (
          `★${r.rating} ${r.verified ? '(verified)' : ''} | ${r.date}` +
          `${url ? ` | ${url}` : ''}\n` +
          `${r.title ? r.title + '. ' : ''}${r.text}`
        );
      })
      .join('\n\n---\n\n');

    // System prompt gives LLM both layers:
    //   compactSnapshot → breadth (full distribution)
    //   detailedContext → depth (full text + links for relevant reviews)
    const sysPrompt = chatSystemPrompt(compactSnapshot, detailedContext, reviews.length, productName);
    chatHistory.push({ role: 'user', content: question });

    const filterLabel =
      ratingFilter === '1-2' ? ' · 1–2★ only' :
      ratingFilter === '4-5' ? ' · 4–5★ only' : '';
    let fullReply = '';

    await streamChat(chatHistory, sysPrompt,
      chunk => {
        fullReply += chunk;
        bubble.textContent = fullReply;
        scrollToBottom();
      },
      () => {
        bubble.classList.remove('typing-cursor');
        bubble.innerHTML = markdownToHtml(fullReply);
        chatHistory.push({ role: 'assistant', content: fullReply });

        assistantEl.querySelectorAll('.rag-badge').forEach(b => b.remove());
        const badge = document.createElement('div');
        badge.className = 'rag-badge';
        badge.innerHTML =
          `<span class="rag-icon">🔍</span> ` +
          `${uniqueReviews.length} of ${reviews.length} reviews${filterLabel}`;
        assistantEl.appendChild(badge);
      },
      err => {
        bubble.classList.remove('typing-cursor');
        bubble.textContent = err.includes('limit') ? err : `Error: ${err}`;
      }
    );
  } catch (err) {
    bubble.classList.remove('typing-cursor');
    bubble.textContent = `Error: ${err.message}`;
  } finally {
    isChatting = false;
    sendBtn.disabled = false;
  }
}

// ── Tool-call helper ─────────────────────────────────────────────────────────
// POST to /chat with tools (worker uses non-streaming generateContent + AUTO mode).
// Returns:
//   { type: 'call', name, args } — LLM called the search tool
//   { type: 'text', text }       — LLM answered directly (no tool needed)
//   null                         — network error or empty response
async function callWithTool(messages, systemPrompt, toolDef) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, systemPrompt, tools: [toolDef] }),
    });
  } catch { return null; }

  if (!res.ok) {
    res.json().then(e => console.warn('[ReviewLens] callWithTool error:', e)).catch(() => {});
    return null;
  }

  try {
    const data = await res.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const fc = parts.find(p => p.functionCall);
    if (fc) return { type: 'call', name: fc.functionCall.name, args: fc.functionCall.args };
    const tp = parts.find(p => p.text);
    if (tp) return { type: 'text', text: tp.text };
    return null;
  } catch { return null; }
}

// ── Streaming helper ─────────────────────────────────────────────────────────
async function streamChat(messages, systemPrompt, onChunk, onDone, onError) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, systemPrompt }),
    });
  } catch (e) {
    onError('Network error — check your connection.');
    return;
  }

  if (!res.ok) {
    try {
      const err = await res.json();
      onError(err.error || `Request failed (${res.status})`);
    } catch {
      onError(`Request failed (${res.status})`);
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const data = JSON.parse(payload);
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) onChunk(text);
        } catch {}
      }
    }
    onDone();
  } catch (e) {
    onError('Stream interrupted.');
  }
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function addMessage(role, content, ragMeta = null) {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = content;
  wrap.appendChild(bubble);

  if (ragMeta && role === 'assistant') {
    const badge = document.createElement('div');
    badge.className = 'rag-badge';
    badge.innerHTML = `<span class="rag-icon">🔍</span> ${ragMeta}`;
    wrap.appendChild(badge);
  }

  messagesEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function showSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'embed-notice';
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  mainEl.scrollTop = mainEl.scrollHeight;
}

function starsFromRating(r) {
  const full = Math.round(r);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

function parseReviewDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/\w+ \d+, \d{4}/);
  return m ? new Date(m[0]) : null;
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function autoResizeInput() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 80) + 'px';
}

// ── Event listeners ───────────────────────────────────────────────────────────
sendBtn.addEventListener('click', () => handleQuestion(chatInput.value.trim()));

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleQuestion(chatInput.value.trim());
  }
});

chatInput.addEventListener('input', autoResizeInput);

// Focus ring on the input wrap container (not the raw textarea)
const inputWrap = document.getElementById('input-wrap');
chatInput.addEventListener('focus', () => inputWrap?.classList.add('focused'));
chatInput.addEventListener('blur',  () => inputWrap?.classList.remove('focused'));

genSummaryBtn?.addEventListener('click', () => generateSummary(false));
refreshSumBtn?.addEventListener('click', () => generateSummary(true));

document.querySelectorAll('.filter-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ratingFilter = btn.dataset.filter;
  });
});

// Links inside the panel iframe can't navigate via target="_blank" because
// the iframe is embedded in a third-party page (Amazon). Use window.open
// via event delegation to force external links open in a new tab.
messagesEl.addEventListener('click', e => {
  const a = e.target.closest('a[href^="http"]');
  if (!a) return;
  e.preventDefault();
  window.open(a.href, '_blank', 'noopener,noreferrer');
});

// ── Markdown renderer ────────────────────────────────────────────────────────
function markdownToHtml(text) {
  // Escape HTML entities to prevent XSS
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Process inline markup.
  // Both markdown links [text](url) and bare https:// URLs are extracted into a
  // placeholder table BEFORE HTML-escaping so URLs aren't mangled, then restored
  // as <a> elements at the end.
  const inline = s => {
    const links = [];
    const extract = (text, url) => {
      links.push({ text, url });
      return `\x02${links.length - 1}\x03`;
    };
    const withPlaceholders = s
      // Markdown links first
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => extract(text, url))
      // Then bare URLs that weren't already captured
      .replace(/(https?:\/\/[^\s<>"')\]\x02\x03]+)/g, url => extract(url, url));

    return esc(withPlaceholders)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\x02(\d+)\x03/g, (_, i) => {
        const { text, url } = links[+i];
        return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
      });
  };

  const lines = text.split('\n');
  let html = '';
  let inList = false;

  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^#{1,4} /.test(line)) {
      closeList();
      html += `<p class="md-heading">${inline(line.replace(/^#{1,4} /, ''))}</p>`;
    } else if (/^[*\-] /.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return html;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
init();
