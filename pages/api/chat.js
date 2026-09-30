import { looksLikeAction, parseMcpConfig } from '../../lib/agp';
import { openClient, genericLooksLikeAction } from '../../lib/mcpClient';
import { callModel } from '../../lib/models';

const MARKER_RE = /<!--ACTION_PROPOSAL:(.*?)-->/s;

function extractPendingProposal(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'assistant') continue;
    const m = messages[i].content?.match(MARKER_RE);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    }
    break;
  }
  return null;
}

function toolSchemaFor(prefixedName, tool) {
  return {
    type: 'function',
    function: {
      name: prefixedName,
      description: `[${tool.sourceLabel}] ${tool.description || ''}`,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const groqKey = req.headers['x-groq-key'];
  const geminiKey = req.headers['x-gemini-key'];
  if (!groqKey && !geminiKey) return res.status(400).json({ error: 'Missing API key — add a Groq or Gemini key in Settings' });

  const { messages, agpConfigText, latchConfigTexts } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages[] is required' });

  const allOpenConnections = [];
  try {
    // Every connected source, uniform shape, so the rest of this file
    // doesn't need to special-case AGP vs. Latch.
    const sources = [
      { id: 'agp', label: 'AGP', configText: agpConfigText, classify: looksLikeAction },
      ...(Array.isArray(latchConfigTexts) ? latchConfigTexts : []).map((text, i) => ({
        id: `latch${i + 1}`,
        label: `Latch ${i + 1}`,
        configText: text,
        classify: genericLooksLikeAction,
      })),
    ].filter((s) => s.configText && s.configText.trim());

    const registry = new Map(); // prefixedName -> { client, originalName, sourceLabel }
    const readToolSchemas = [];
    const actionToolSummaries = []; // { prefixedName, label, firstSentence }
    const statusNotes = [];
    const openConnections = allOpenConnections; // close() fns — always closed in the finally block below
    let anyConnected = false;

    for (const source of sources) {
      const parsed = parseMcpConfig(source.configText);
      if (parsed.error) {
        statusNotes.push(`${source.label}: connection FAILED — ${parsed.error}. Do not invent ${source.label} data.`);
        continue;
      }

      // One connection per source for the whole request — for a stdio
      // source (like Latch) this spawns one process, not one per tool call.
      let client;
      try {
        const opened = await openClient(parsed);
        client = opened.client;
        openConnections.push(opened.close);
      } catch (err) {
        statusNotes.push(`${source.label}: connection FAILED — ${err?.message || err}. Do not invent ${source.label} data.`);
        continue;
      }

      let listing;
      try {
        listing = await client.listTools();
      } catch (err) {
        statusNotes.push(`${source.label}: connection FAILED — ${err?.message || err}. Do not invent ${source.label} data.`);
        continue;
      }
      const listedTools = listing.tools || [];
      if (listedTools.length === 0) {
        statusNotes.push(`${source.label}: connected but reported zero tools.`);
        continue;
      }

      anyConnected = true;
      for (const tool of listedTools) {
        const prefixedName = `${source.id}__${tool.name}`;
        registry.set(prefixedName, { client, originalName: tool.name, sourceLabel: source.label });
        const isAction = source.classify(tool);
        if (isAction) {
          const firstSentence = (tool.description || '').split(/(?<=[.!?])\s/)[0].slice(0, 140);
          actionToolSummaries.push({ prefixedName, label: source.label, name: tool.name, summary: firstSentence });
        } else {
          readToolSchemas.push(toolSchemaFor(prefixedName, { ...tool, sourceLabel: source.label }));
        }
      }
    }

    const pending = extractPendingProposal(messages);

    const tools = [...readToolSchemas];
    if (actionToolSummaries.length) {
      tools.push({
        type: 'function',
        function: {
          name: 'propose_action',
          description:
            "Use this when the user wants to do something that spends real money or commits to an irreversible action on a connected source (AGP or a Latch). Does NOT execute anything — only records what you plan to do so the user can confirm. Real dollar/cost figures usually are NOT in a tool's own description; they come back as data from a read tool (e.g. AGP's list_tracks / my_race / track_state). Fetch those first if you don't already have them this conversation, and put the real numbers in the description argument — never a placeholder.",
          parameters: {
            type: 'object',
            properties: {
              tool_name: { type: 'string', description: 'The exact prefixed tool name to run once confirmed, e.g. "agp__start_track" or "latch1__send_payment"' },
              arguments: { type: 'object', description: 'Arguments to call that tool with' },
              description: { type: 'string', description: 'One short, plain-English sentence describing the action AND its real cost if known, e.g. "Start Track 3 — spend cap $5.00"' },
            },
            required: ['tool_name', 'description'],
          },
        },
      });
    }
    if (pending) {
      tools.push({
        type: 'function',
        function: {
          name: 'confirm_and_run_action',
          description:
            "Call this ONLY if the user's latest message clearly confirms going ahead with the previously proposed action. This actually executes it and cannot be undone.",
          parameters: { type: 'object', properties: {} },
        },
      });
    }

    let actionToolsNote = '';
    if (actionToolSummaries.length) {
      actionToolsNote = `\n\nThese actions spend real money or commit you to something irreversible — never call them directly. Check any relevant balance/read tool first if you don't already know the cost, then use propose_action, cite real numbers, and ask the user to confirm:\n${actionToolSummaries
        .map((t) => `- ${t.prefixedName} [${t.label}]: ${t.summary}`)
        .join('\n')}`;
    }

    let pendingNote = '';
    if (pending) {
      pendingNote = `\n\nThe user was just asked to confirm this action: "${pending.description}" (tool: ${pending.name}). If their latest message clearly says yes/confirm/go ahead/do it, call confirm_and_run_action. If they said no or changed the subject, don't call it — just acknowledge.`;
    }

    let connectionNote = '';
    if (statusNotes.length) {
      connectionNote = `\n\nConnection status:\n${statusNotes.map((s) => `- ${s}`).join('\n')}`;
    }
    if (sources.length === 0) {
      connectionNote += `\n\nNo AGP or Latch config is connected. If the user asks about races, balances, or a Latch, tell them to add it in Settings — do not invent data.`;
    }

    const systemPrompt = {
      role: 'system',
      content:
        `You are a helpful chat assistant.${anyConnected ? ' You have tools from one or more connected sources (AGP and/or Latch) — use the read ones automatically whenever they help answer the user, without asking permission first. Tool names are prefixed by source (agp__..., latch1__..., etc) but never mention that prefix or any technical name to the user. For AGP specifically: list_tracks returns tracks in every phase including finished ones (with a winner field) — that IS race history, there is no separate history tool.' : ''}${actionToolsNote}${pendingNote}${connectionNote}\n\nHard rule: NEVER invent, guess, estimate, or make up results, balances, names, dates, or any other data from a connected source. Only state facts that came back from an actual tool call in this conversation. If you don't have real data, say so directly instead of guessing.\n\nCounts: if the user asks for something to be done N times, make exactly N calls, no more and no fewer, then report every result. IMPORTANT: if those N calls don't depend on each other's results, issue ALL of them together as multiple tool calls in the SAME turn, not one at a time across separate turns — this app has a tight per-minute token budget, and calling them one-by-one across many turns is much more likely to hit it and fail. Only spread calls across turns when a later one genuinely needs an earlier result first.\n\nFormatting: when a tool returns a list of items, present it as a clean markdown table so it's easy to scan. For a single fact, answer in a sentence or two. Never mention tool names, source prefixes, raw JSON, or technical implementation details — just present the information naturally.\n\nContinuity: always read the whole earlier conversation before answering and reply as one continuous chat — refer back to what was already said or done. Never mention models, providers, APIs, or any switching between them, and never act as if the conversation is starting fresh or as if you are a different assistant.`,
    };

    const MAX_HISTORY_MESSAGES = 16;
    const cleanHistory = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: (m.content || '').replace(MARKER_RE, '').trim() }))
      .filter((m) => m.content)
      .slice(-MAX_HISTORY_MESSAGES);

    const readToolNames = new Set(readToolSchemas.map((t) => t.function.name));

    let convo = [systemPrompt, ...cleanHistory];
    let finalText = '';
    let newProposal = null;
    let executedProposal = false;

    const modelKeys = { groqKey, geminiKey };
    let providerUsed = null;
    const toolLog = [];
    const serialize = (r) => {
      const str = JSON.stringify(r);
      return str.length > 4000 ? str.slice(0, 4000) + '…[truncated]' : str;
    };

    for (let i = 0; i < 6; i++) {
      const result = await callModel(modelKeys, convo, tools);
      if (!result.ok) {
        return res.status(result.status || 500).json({ error: result.error || 'Model request failed' });
      }
      providerUsed = result.provider;

      const msg = result.message;
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalText = msg.content || '';
        break;
      }

      convo.push(result.rawAssistantMsg);
      for (const tc of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          /* ignore malformed args */
        }

        let result;
        if (tc.function.name === 'propose_action') {
          newProposal = { name: args.tool_name, arguments: args.arguments || {}, description: args.description };
          result = { status: 'proposed', note: 'Recorded. Awaiting user confirmation before running.' };
        } else if (tc.function.name === 'confirm_and_run_action' && pending) {
          const entry = registry.get(pending.name);
          if (entry) {
            try {
              result = await entry.client.callTool({ name: entry.originalName, arguments: pending.arguments || {} });
            } catch (err) {
              result = { error: err?.message || String(err) };
            }
            toolLog.push(`${entry.sourceLabel}: ${entry.originalName}`);
            executedProposal = true;
          } else {
            result = { error: 'Could not find the previously proposed tool — it may no longer be connected.' };
            executedProposal = true;
          }
        } else if (readToolNames.has(tc.function.name)) {
          // Only ever directly execute a tool that was actually offered as
          // read-only. Anything else — including a hallucinated call to an
          // action tool by name — is refused here, not just relied on Groq
          // to reject.
          const entry = registry.get(tc.function.name);
          if (entry) {
            try {
              result = await entry.client.callTool({ name: entry.originalName, arguments: args || {} });
            } catch (err) {
              result = { error: err?.message || String(err) };
            }
            toolLog.push(`${entry.sourceLabel}: ${entry.originalName}`);
          } else {
            result = { error: 'Unknown tool.' };
          }
        } else {
          result = {
            error: `'${tc.function.name}' can't be called directly. If this spends real money or is irreversible, call propose_action with tool_name: '${tc.function.name}' instead.`,
          };
        }

        convo.push({ role: 'tool', tool_call_id: tc.id, content: serialize(result) });
      }
    }

    if (!finalText.trim()) {
      const forced = await callModel(modelKeys, convo, tools, true);
      if (!forced.ok) {
        return res.status(forced.status || 500).json({ error: forced.error || 'Model request failed' });
      }
      providerUsed = forced.provider;
      finalText = forced.message.content || '';
    }

    if (newProposal && !executedProposal) {
      finalText += `\n\n<!--ACTION_PROPOSAL:${JSON.stringify(newProposal)}-->`;
    }

    return res.status(200).json({ reply: finalText, toolCalls: toolLog, provider: providerUsed });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  } finally {
    // Always shut down every spawned/opened connection (Latch stdio
    // processes especially) — never leave one hanging past this request.
    await Promise.all(allOpenConnections.map((close) => close()));
  }
}