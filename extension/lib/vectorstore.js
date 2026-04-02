export function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Score-based retrieval: returns all chunks above a relevance threshold,
 * up to a hard cap. Falls back to top chunks if nothing clears the threshold.
 *
 * @param {number[]} queryVector
 * @param {Array} chunks
 * @param {object} opts
 * @param {number}  opts.scoreThreshold - min cosine similarity to include (default 0.3)
 * @param {number}  opts.hardCap        - absolute max chunks to send (default 60)
 * @param {number}  opts.fallbackK      - chunks to return if nothing passes threshold (default 20)
 * @param {'all'|'1-2'|'4-5'} opts.ratingFilter
 */
export function search(queryVector, chunks, {
  scoreThreshold = 0.3,
  hardCap = 60,
  fallbackK = 20,
  ratingFilter = 'all',
} = {}) {
  let pool = chunks;
  if (ratingFilter === '1-2') pool = chunks.filter(c => c.rating <= 2);
  else if (ratingFilter === '4-5') pool = chunks.filter(c => c.rating >= 4);

  if (pool.length === 0) return [];

  const scored = pool
    .map(chunk => ({ ...chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
    .sort((a, b) => b.score - a.score);

  const relevant = scored.filter(c => c.score >= scoreThreshold).slice(0, hardCap);

  // If threshold was too strict, fall back to top N
  return relevant.length >= 3 ? relevant : scored.slice(0, Math.min(fallbackK, scored.length));
}
