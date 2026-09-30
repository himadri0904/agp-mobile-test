import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function describeError(err) {
  if (err?.message) return err.message;
  return String(err);
}

/**
 * Parses a pasted Claude-style mcpServers JSON block into a connection
 * descriptor. Handles two shapes:
 *   - streamable-http: a command that runs "mcp-remote <url> --header ..."
 *     (e.g. AGP's config) — resolves ${VAR} refs against the env block.
 *   - stdio: an explicit "type": "stdio" server, or any other command that
 *     isn't going through mcp-remote (e.g. Latch's own package) — run
 *     directly as a local child process.
 */
export function parseMcpConfig(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: "That doesn't look like valid JSON — check for a missing comma, quote, or bracket." };
  }

  const servers = json.mcpServers || json.servers || json;
  const serverName = servers && typeof servers === 'object' ? Object.keys(servers)[0] : null;
  if (!serverName) {
    return { error: 'No "mcpServers" entry found in that config.' };
  }

  const server = servers[serverName] || {};
  const command = server.command;
  const args = Array.isArray(server.args) ? server.args : [];
  const env = server.env && typeof server.env === 'object' ? server.env : {};
  const explicitType = server.type;
  const usesMcpRemote = args.some((a) => /mcp-remote/i.test(a));

  if (explicitType === 'stdio' || (command && !usesMcpRemote)) {
    if (!command) return { error: `Found "${serverName}" but no "command" to run it.` };
    return { transport: 'stdio', command, args, env, serverName, error: null };
  }

  const url = args.find((a) => /^https?:\/\//i.test(a));
  if (!url) return { error: `Found "${serverName}" but no server URL in its args.` };

  const headers = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--header' && typeof args[i + 1] === 'string') {
      const raw2 = args[i + 1];
      const sep = raw2.indexOf(':');
      if (sep > -1) {
        const name = raw2.slice(0, sep).trim();
        let value = raw2.slice(sep + 1).trim();
        value = value.replace(/\$\{([^}]+)\}/g, (_, varName) => (env[varName] != null ? String(env[varName]) : ''));
        headers[name] = value;
      }
    }
  }
  if (Object.keys(headers).length === 0) {
    return { error: `Found "${serverName}" but no --header auth values in its args.` };
  }

  return { transport: 'streamable-http', url, headers, serverName, error: null };
}

function buildTransport(config) {
  if (config.transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env },
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
}

async function withClient(config, fn) {
  const transport = buildTransport(config);
  const client = new Client({ name: 'multi-mcp-chat', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Opens ONE connection and hands back the live client plus a close()
 * function. Use this whenever a request will make several calls to the
 * same source (e.g. list tools, then call a tool, maybe more than once) —
 * for a stdio source like Latch, each connection spawns a real child
 * process, so reconnecting per call is slow and wasteful. Caller is
 * responsible for calling close() when done (a finally block).
 */
export async function openClient(config) {
  const transport = buildTransport(config);
  const client = new Client({ name: 'multi-mcp-chat', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close().catch(() => {}) };
}

/** Returns { tools, error }. On failure tools is [] and error is human-readable. */
export async function listTools(config) {
  try {
    const result = await withClient(config, (client) => client.listTools());
    return { tools: result.tools || [], error: null };
  } catch (err) {
    return { tools: [], error: describeError(err) };
  }
}

export async function callTool(config, name, args) {
  try {
    return await withClient(config, (client) => client.callTool({ name, arguments: args || {} }));
  } catch (err) {
    return { error: describeError(err) };
  }
}

/** Step-by-step trace for a "Test connection" button. */
export async function diagnose(config) {
  const steps = [];
  try {
    const transport = buildTransport(config);
    const client = new Client({ name: 'multi-mcp-chat', version: '1.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      steps.push({
        step: 'connect (initialize handshake)',
        status: 'ok',
        transport: config.transport,
        target: config.transport === 'stdio' ? `${config.command} ${(config.args || []).join(' ')}` : config.url,
      });
    } catch (err) {
      steps.push({ step: 'connect (initialize handshake)', status: 'failed', error: describeError(err) });
      return { steps };
    }

    try {
      const result = await client.listTools();
      steps.push({
        step: 'tools/list',
        status: 'ok',
        toolCount: result.tools?.length || 0,
        tools: (result.tools || []).map((t) => ({ name: t.name, description: t.description })),
      });
    } catch (err) {
      steps.push({ step: 'tools/list', status: 'failed', error: describeError(err) });
    }
    await client.close().catch(() => {});
  } catch (err) {
    steps.push({ step: 'setup', status: 'failed', error: describeError(err) });
  }
  return { steps };
}

// Generic fallback classifier for tools from sources we don't have
// hardcoded knowledge of (e.g. Latch) — errs toward requiring confirmation
// whenever a name/description suggests money movement or a committed action.
const ACTION_WORDS = ['bet', 'wager', 'stake', 'place', 'submit', 'commit', 'guess', 'answer', 'claim', 'buy', 'sell', 'transfer', 'ask', 'pay', 'send', 'withdraw', 'deposit', 'spend', 'charge', 'delete', 'remove', 'cancel'];
const ACTION_WORD_RE = new RegExp(`\\b(${ACTION_WORDS.join('|')})\\b`, 'i');

export function genericLooksLikeAction(tool) {
  const hay = `${tool.name} ${tool.description || ''}`;
  return ACTION_WORD_RE.test(hay);
}
