// Normalizes Groq and Gemini behind one interface so the rest of the app
// (the tool-calling loop in pages/api/chat.js) never has to know which
// provider actually answered. Both callGroq() and callGemini() return the
// same shape:
//   { ok, status, provider, message: { content, tool_calls }, rawAssistantMsg, error? }
// `rawAssistantMsg` is what gets pushed back into `convo` for the next
// round — for Gemini this is a synthetic OpenAI-shaped message; the
// translator below (toGeminiContents) knows how to read it back out again
// on the next call, so the rest of the app only ever deals in one message
// format regardless of provider.

const GROQ_MODEL = 'openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function parseWaitMs(message) {
  const msMatch = message?.match(/try again in ([\d.]+)ms/i);
  if (msMatch) return Math.ceil(parseFloat(msMatch[1])) + 200;
  const sMatch = message?.match(/try again in ([\d.]+)s/i);
  if (sMatch) return Math.ceil(parseFloat(sMatch[1]) * 1000) + 200;
  return 2000;
}

// History may contain tool calls that Gemini produced (mid-conversation
// fallback). Groq is strict: every tool_call needs type:'function' and no
// unknown fields, so normalize before sending.
function toGroqMessages(convo) {
  return convo.map((m) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
        })),
      };
    }
    return m;
  });
}

async function callGroqOnce(groqKey, convo, tools, forceText) {
  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: toGroqMessages(convo),
        tools: tools.length ? tools : undefined,
        tool_choice: forceText && tools.length ? 'none' : undefined,
        stream: false,
      }),
    });
    const data = await upstream.json();
    return { ok: upstream.ok, status: upstream.status, data };
  } catch (err) {
    return { ok: false, status: 500, data: { error: { message: err?.message || 'Groq request failed' } } };
  }
}

export async function callGroq(groqKey, convo, tools, forceText = false) {
  // Deliberately small retry budget: with several tool-calling rounds per
  // turn, each making its own call, a generous per-round retry compounds
  // into a very long hang. Fail fast so callModel() can fall back to
  // Gemini instead of waiting.
  const MAX_ATTEMPTS = 2;
  let last;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await callGroqOnce(groqKey, convo, tools, forceText);
    if (last.ok) break;

    // A DAILY cap can't be waited out inside one request — don't retry it.
    if (last.status === 429 && /tokens per day|TPD/i.test(last.data?.error?.message || '')) break;

    if (last.status === 429 && attempt < MAX_ATTEMPTS) {
      const waitMs = Math.min(parseWaitMs(last.data?.error?.message), 4000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    break;
  }

  if (!last.ok) {
    return { ok: false, status: last.status, provider: 'groq', error: last.data?.error?.message || 'Groq API request failed' };
  }
  const msg = last.data?.choices?.[0]?.message;
  if (!msg) {
    return { ok: false, status: 502, provider: 'groq', error: 'Groq returned an empty response' };
  }
  return {
    ok: true,
    provider: 'groq',
    message: { content: msg.content || '', tool_calls: msg.tool_calls || null },
    rawAssistantMsg: msg,
  };
}

// Gemini's function-declaration schema is a restricted OpenAPI-3.0 subset —
// it rejects standard JSON-Schema keys like "$schema" and
// "additionalProperties" outright (whole request fails, not just that
// field). MCP servers (Latch, and some AGP tools) routinely include both.
// Strip them recursively — through properties, items, and any nested
// object — without touching anything else in the schema.
const GEMINI_UNSUPPORTED_KEYS = new Set(['$schema', 'additionalProperties', '$id', '$ref', '$defs', 'definitions']);

function sanitizeSchemaForGemini(schema) {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini);
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(schema)) {
      if (GEMINI_UNSUPPORTED_KEYS.has(key)) continue;
      out[key] = sanitizeSchemaForGemini(value);
    }
    return out;
  }
  return schema;
}

function toGeminiTools(tools) {
  const decls = tools.map((t) => {
    const rawParams = t.function.parameters && Object.keys(t.function.parameters.properties || {}).length
      ? t.function.parameters
      : { type: 'object', properties: {} };
    return {
      name: t.function.name,
      description: t.function.description || '',
      parameters: sanitizeSchemaForGemini(rawParams),
    };
  });
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

// convo entries are the normalized shape used throughout chat.js:
//   { role: 'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id? }
function toGeminiContents(convo) {
  let systemText = '';
  const contents = [];
  const idToName = new Map();

  for (const m of convo) {
    if (m.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + (m.content || '');
    } else if (m.role === 'user') {
      if ((m.content || '').trim()) contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) {
        const parts = [];
        if ((m.content || '').trim()) parts.push({ text: m.content });
        m.tool_calls.forEach((tc) => {
          idToName.set(tc.id, tc.function.name);
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || '{}');
          } catch {
            /* ignore malformed args */
          }
          // Gemini 3 requires the thoughtSignature to be echoed back on the
          // same part. Calls that came from Groq (mid-conversation fallback)
          // have none, so use Google's documented bypass value for those.
          parts.push({
            functionCall: { name: tc.function.name, args },
            thoughtSignature: tc.thought_signature || 'skip_thought_signature_validator',
          });
        });
        contents.push({ role: 'model', parts });
      } else if ((m.content || '').trim()) {
        contents.push({ role: 'model', parts: [{ text: m.content }] });
      }
    } else if (m.role === 'tool') {
      const name = idToName.get(m.tool_call_id) || 'unknown_function';
      let responseObj;
      try {
        responseObj = JSON.parse(m.content);
      } catch {
        responseObj = { result: m.content };
      }
      if (responseObj === null || typeof responseObj !== 'object' || Array.isArray(responseObj)) {
        responseObj = { result: responseObj };
      }
      const part = { functionResponse: { name, response: responseObj } };
      // Parallel calls: ALL responses must sit in ONE user turn, in order.
      const prev = contents[contents.length - 1];
      if (prev && prev.role === 'user' && prev.parts.every((x) => x.functionResponse)) {
        prev.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
    }
  }

  // Gemini wants the conversation to open with a user turn.
  while (contents.length && contents[0].role !== 'user') contents.shift();

  return { systemText, contents };
}

let geminiCallCounter = 0;

export async function callGemini(geminiKey, convo, tools, forceText = false) {
  const { systemText, contents } = toGeminiContents(convo);
  const body = {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    ...(tools.length && !forceText ? { tools: toGeminiTools(tools) } : {}),
  };

  let upstream, data;
  try {
    upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify(body),
    });
    data = await upstream.json();
  } catch (err) {
    return { ok: false, status: 500, provider: 'gemini', error: err?.message || String(err) };
  }

  if (!upstream.ok) {
    return { ok: false, status: upstream.status, provider: 'gemini', error: data?.error?.message || 'Gemini API request failed' };
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  let text = '';
  const tool_calls = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) {
      geminiCallCounter += 1;
      tool_calls.push({
        id: `gemini-call-${Date.now()}-${geminiCallCounter}`,
        type: 'function',
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
        // sibling of functionCall on the part; must be returned unchanged next round
        ...(p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {}),
      });
    }
  }

  const rawAssistantMsg = { role: 'assistant', content: text, tool_calls: tool_calls.length ? tool_calls : undefined };
  return {
    ok: true,
    provider: 'gemini',
    message: { content: text, tool_calls: tool_calls.length ? tool_calls : null },
    rawAssistantMsg,
  };
}

/**
 * Uses whichever provider is available and, if it fails for ANY reason,
 * quietly hands the same turn (same full conversation) to the other one.
 * Groq is tried first (fast); if Groq fails -> Gemini; if Gemini is the
 * one that fails (e.g. Gemini-only key order or Groq absent) -> Groq.
 * Only when every available provider fails does an error come back.
 */
export async function callModel({ groqKey, geminiKey }, convo, tools, forceText = false) {
  if (!groqKey && !geminiKey) {
    return { ok: false, status: 400, provider: null, error: 'No model API key provided — add a Groq or Gemini key in Settings.' };
  }

  const order = [];
  if (groqKey) order.push(['groq', () => callGroq(groqKey, convo, tools, forceText)]);
  if (geminiKey) order.push(['gemini', () => callGemini(geminiKey, convo, tools, forceText)]);

  // Remember which provider worked last and try it first next time, so a
  // broken/rate-limited provider isn't retried on every single round.
  order.sort((a, b) => (a[0] === lastGood ? -1 : b[0] === lastGood ? 1 : 0));

  let lastResult;
  for (const [name, run] of order) {
    let r;
    try {
      r = await run();
    } catch (err) {
      r = { ok: false, status: 500, provider: name, error: err?.message || String(err) };
    }
    if (r.ok) {
      lastGood = name;
      return r;
    }
    lastResult = r;
  }
  return lastResult;
}

let lastGood = null;