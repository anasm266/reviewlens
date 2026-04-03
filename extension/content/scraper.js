(async () => {
  const asin = window.location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1];
  console.log('[ReviewLens scraper] asin:', asin);
  if (!asin) return;

  // Skip scraping if local data is <14 days old and complete
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
  const stored = await new Promise(res => chrome.storage.local.get(`rl_scrape_${asin}`, d => res(d)));
  const existing = stored[`rl_scrape_${asin}`];
  if (existing?.status === 'complete' && (Date.now() - (existing.scrapedAt || 0)) < CACHE_TTL_MS) {
    console.log('[ReviewLens scraper] fresh local cache found — skipping scrape');
    chrome.runtime.sendMessage({ type: 'REGISTER_TAB', asin });
    return;
  }

  const stats = {
    productTitle: document.querySelector('#productTitle')?.innerText?.trim()
      || document.title.split(':')[0].trim(),
    overallRating: document.querySelector('[data-hook="rating-out-of-text"]')?.innerText?.trim() ?? null,
    totalCount: document.querySelector('[data-hook="total-review-count"]')?.innerText?.trim() ?? null,
    breakdown: [...document.querySelectorAll('[data-hook="rating-filter"]')].map(el => el.innerText.trim()),
  };

  chrome.runtime.sendMessage({ type: 'REGISTER_TAB', asin });

  let allReviews = [];

  const origin = window.location.origin; // e.g. https://www.amazon.co.uk

  const save = (reviews, extra = {}) => {
    allReviews = reviews;
    chrome.storage.local.set({
      [`rl_scrape_${asin}`]: { asin, reviews, stats, origin, scrapedAt: Date.now(), ...extra },
    }, () => {
      if (chrome.runtime.lastError) console.error('[ReviewLens scraper] save error:', chrome.runtime.lastError);
    });
  };

  const fetchPage = async (pageNum) => {
    try {
      const url = `${origin}/product-reviews/${asin}?reviewerType=all_reviews&sortBy=recent&pageNumber=${pageNum}`;
      const res = await fetch(url);
      if (!res.ok) return null;
      return new DOMParser().parseFromString(await res.text(), 'text/html');
    } catch { return null; }
  };

  const parseReviews = (doc) => {
    if (!doc) return [];
    return [...doc.querySelectorAll('[data-hook="review"]')].map(el => ({
      reviewId: el.id?.match(/R[A-Z0-9]{6,}/)?.[0] ?? null,
      text: el.querySelector('[data-hook="review-body"] span')?.innerText?.trim(),
      title: el.querySelector('[data-hook="review-title"] > span:not([class])')?.innerText?.trim() ?? '',
      rating: parseFloat(el.querySelector('[data-hook="review-star-rating"]')?.innerText) || null,
      date: el.querySelector('[data-hook="review-date"]')?.innerText?.trim() ?? '',
      verified: !!el.querySelector('[data-hook="avp-badge"]'),
      helpful: el.querySelector('[data-hook="helpful-vote-statement"]')?.innerText?.trim() ?? '0',
    })).filter(r => r.text && r.rating);
  };

  // ── Bootstrap ────────────────────────────────────────────────────────────────
  let totalPages = 1;

  try {
    const firstPage = await fetchPage(1);
    if (!firstPage) { save([], { status: 'complete' }); return; }

    if (!firstPage.querySelector('[data-hook="review"]')) {
      save([], { status: 'captcha', captcha: true }); return;
    }

    const rawCount = parseInt((stats.totalCount || '0').replace(/[^0-9]/g, '')) || 0;
    totalPages = Math.min(100, Math.max(1, Math.ceil(rawCount / 10))); // cap 1000 reviews

    allReviews = parseReviews(firstPage);
    console.log('[ReviewLens scraper] page 1:', allReviews.length, 'reviews | totalPages:', totalPages);

    // Save page 1 immediately — panel can open straight away
    save(allReviews, {
      status: totalPages > 1 ? 'loading' : 'complete',
      pagesFetched: 1,
      totalPages,
    });

    // Continuously fetch all remaining pages in background
    for (let p = 2; p <= totalPages; p++) {
      await new Promise(r => setTimeout(r, 300));
      const page = await fetchPage(p);
      const newReviews = parseReviews(page);
      allReviews = allReviews.concat(newReviews);
      save(allReviews, {
        status: p < totalPages ? 'loading' : 'complete',
        pagesFetched: p,
        totalPages,
      });
    }

  } catch (err) {
    console.error('[ReviewLens scraper] error:', err);
    save(allReviews.length ? allReviews : [], { status: 'complete', error: err.message });
  }
})();
