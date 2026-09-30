import { parseMcpConfig, listTools, callTool, diagnose } from '../../lib/mcpClient';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, name, arguments: args, agpConfigText, configText } = req.body || {};
  const raw = configText || agpConfigText;
  if (!raw) return res.status(400).json({ error: 'Missing configText (paste your mcpServers JSON)' });

  const parsed = parseMcpConfig(raw);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    if (action === 'diagnose') {
      const result = await diagnose(parsed);
      return res.status(200).json(result);
    }
    if (action === 'list') {
      const listing = await listTools(parsed);
      if (listing.error) return res.status(502).json({ error: listing.error });
      return res.status(200).json({ tools: listing.tools });
    }
    if (action === 'call') {
      if (!name) return res.status(400).json({ error: 'Tool name is required' });
      const result = await callTool(parsed, name, args || {});
      return res.status(200).json({ result });
    }
    return res.status(400).json({ error: 'action must be "diagnose", "list", or "call"' });
  } catch (err) {
    return res.status(500).json({ error: 'Proxy error: ' + err.message });
  }
}
