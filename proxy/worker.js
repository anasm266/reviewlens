const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CHAT_LIMIT = 200;   // covers both tool-search iterations and streaming answers
const EMBED_LIMIT = 30;

async function rateCheck(key, limit, env) {
  const today = new Date().toISOString().split('T')[0];
  const rkey = `${key}:${today}`;
  const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', rkey],
      ['EXPIRE', rkey, 86400],
    ]),
  });
  const data = await res.json();
  return data[0].result;
}

async function handleEmbed(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const count = await rateCheck(`rl:embed:${ip}`, EMBED_LIMIT, env);
  if (count > EMBED_LIMIT) {
    return json({ error: 'Embedding limit reached for today. Try again tomorrow.' }, 429);
  }

  const { texts, taskType } = await request.json();
  if (!Array.isArray(texts) || texts.length === 0) {
    return json({ error: 'texts must be a non-empty array' }, 400);
  }

  const BATCH = 100;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const requests = batch.map(text => ({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
      taskType: taskType || 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
    }));

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      }
    );

    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || 'Embedding failed' }, res.status);
    allEmbeddings.push(...data.embeddings.map(e => e.values));
  }

  return json({ embeddings: allEmbeddings });
}

async function handleChat(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const count = await rateCheck(`rl:chat:${ip}`, CHAT_LIMIT, env);
  if (count > CHAT_LIMIT) {
    return json({ error: 'Daily limit reached. Try again tomorrow.' }, 429);
  }

  const { messages, systemPrompt, tools } = await request.json();
  const hasTool = Array.isArray(tools) && tools.length > 0;

  // Use gemini-2.5-flash for tool calls (full model, reliable function calling)
  // Use gemini-2.5-flash-lite for plain streaming answers (cheaper, faster)
  const model = hasTool ? 'gemini-2.5-flash' : 'gemini-2.5-flash-lite';

  const geminiBody = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    // Messages may carry pre-built `parts` (function call/response turns) or plain `content`
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: m.parts || [{ text: m.content }],
    })),
    generationConfig: hasTool
      // Allow up to 1024 tokens so the LLM can write a direct answer
      // when it decides no tool call is needed (mode: AUTO).
      ? { temperature: 0.1, maxOutputTokens: 1024 }
      : { maxOutputTokens: 1024 },
    ...(hasTool ? {
      tools: [{ function_declarations: tools }],
      // ANY: LLM must always call the tool. Compact snapshot alone (titles only)
      // is not enough to answer content questions — tool call fetches full text.
      tool_config: { function_calling_config: { mode: 'ANY' } },
    } : {}),
  };

  if (hasTool) {
    // Use non-streaming generateContent for tool calls — streamGenerateContent
    // has a known incompatibility with tool_config and returns a proto validation
    // error ("required oneof field 'data'") when used with the streaming endpoint.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
    );
    const data = await res.json();
    if (!res.ok) return json({ error: data.error?.message || 'Tool call failed' }, res.status);
    return json(data);   // panel reads this as JSON to extract the functionCall
  }

  // Streaming answer (no tools)
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
  );

  if (!geminiRes.ok) {
    const err = await geminiRes.json();
    return json({ error: err.error?.message || 'Chat failed' }, geminiRes.status);
  }

  return new Response(geminiRes.body, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

    const path = new URL(request.url).pathname;
    if (path === '/embed') return handleEmbed(request, env);
    if (path === '/chat') return handleChat(request, env);
    return new Response('Not found', { status: 404, headers: CORS });
  },
};
