const WORKER_URL = 'https://amazon-review-proxy.kingzcopz266.workers.dev';
const CHUNK_MAX_CHARS = 800; // ~200 tokens

export function chunkReviews(reviews) {
  const chunks = [];
  for (const review of reviews) {
    const fullText = review.title ? `${review.title}. ${review.text}` : review.text;
    const meta = { rating: review.rating, date: review.date, verified: review.verified };

    if (fullText.length <= CHUNK_MAX_CHARS) {
      chunks.push({ text: fullText, ...meta });
      continue;
    }

    // Split long reviews by sentence boundaries
    const sentences = fullText.match(/[^.!?]+[.!?]+/g) || [fullText];
    let current = '';
    for (const sentence of sentences) {
      if (current && (current + sentence).length > CHUNK_MAX_CHARS) {
        chunks.push({ text: current.trim(), ...meta });
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push({ text: current.trim(), ...meta });
  }
  return chunks;
}

export async function embedChunks(chunks) {
  const texts = chunks.map(c => c.text);
  const res = await fetch(`${WORKER_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, taskType: 'RETRIEVAL_DOCUMENT' }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Embedding failed');
  }
  const { embeddings } = await res.json();
  return chunks.map((chunk, i) => ({ ...chunk, vector: embeddings[i] }));
}

export async function embedQuery(question) {
  const res = await fetch(`${WORKER_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: [question], taskType: 'RETRIEVAL_QUERY' }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Query embedding failed');
  }
  const { embeddings } = await res.json();
  return embeddings[0];
}
