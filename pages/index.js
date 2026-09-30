import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const MARKER_RE = /<!--ACTION_PROPOSAL:.*?-->/s;
const LATCH_SLOTS = 5;

const AGP_PLACEHOLDER = `{
  "mcpServers": {
    "agp-track-race": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://api.agp.onlatch.com/track/mcp",
        "--header",
        "Authorization:\${AUTH}"
      ],
      "env": {
        "AUTH": "Bearer agpm_..."
      }
    }
  }
}`;

const LATCH_PLACEHOLDER = `{
  "mcpServers": {
    "latch-xxxxxxxx": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "https://onlatch.com/connect/latch-mcp-server.tgz?v=remote-mcp-2"],
      "env": {
        "LATCH_URL": "https://onlatch.com",
        "LATCH_TOKEN": "lat_...",
        "LATCH_ID": "lnk_...",
        "LATCH_LINK": "lnk_..."
      }
    }
  }
}`;

const boxStyle = {
  width: '100%',
  background: '#17181c',
  border: '1px solid #26282d',
  color: '#ffffff',
  borderRadius: 10,
  padding: '10px 12px',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
  resize: 'vertical',
};

const resultStyle = {
  marginTop: 10,
  padding: 10,
  background: '#08090B',
  border: '1px solid #26282d',
  borderRadius: 10,
  fontSize: 11,
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function displayText(content) {
  return content.replace(MARKER_RE, '').trim();
}

export default function Home() {
  const [messages, setMessages] = useState([
    { role: 'system', content: 'Add your Groq key (and AGP / Latch MCP configs, if you want them) in Settings, then just start chatting.' },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [groqKey, setGroqKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [agpConfigText, setAgpConfigText] = useState('');
  const [agpTesting, setAgpTesting] = useState(false);
  const [agpTestResult, setAgpTestResult] = useState(null);
  const [latchConfigs, setLatchConfigs] = useState(Array(LATCH_SLOTS).fill(''));
  const [latchTesting, setLatchTesting] = useState(Array(LATCH_SLOTS).fill(false));
  const [latchTestResults, setLatchTestResults] = useState(Array(LATCH_SLOTS).fill(null));
  const scrollRef = useRef(null);

  useEffect(() => {
    setGroqKey(localStorage.getItem('groqKey') || '');
    setGeminiKey(localStorage.getItem('geminiKey') || '');
    setAgpConfigText(localStorage.getItem('agpConfigText') || '');
    setLatchConfigs(
      Array.from({ length: LATCH_SLOTS }, (_, i) => localStorage.getItem(`latchConfig${i + 1}`) || '')
    );
    const savedMessages = localStorage.getItem('chatMessages');
    if (savedMessages) {
      try {
        const parsed = JSON.parse(savedMessages);
        if (Array.isArray(parsed) && parsed.length) setMessages(parsed);
      } catch {
        /* ignore corrupt saved state */
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('chatMessages', JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function saveSettings() {
    localStorage.setItem('groqKey', groqKey);
    localStorage.setItem('geminiKey', geminiKey);
    localStorage.setItem('agpConfigText', agpConfigText);
    latchConfigs.forEach((val, i) => localStorage.setItem(`latchConfig${i + 1}`, val));
    setShowSettings(false);
  }

  function clearChat() {
    const reset = [{ role: 'system', content: 'Chat cleared. Ask me anything.' }];
    setMessages(reset);
    localStorage.setItem('chatMessages', JSON.stringify(reset));
  }

  async function testConfig(configText) {
    const res = await fetch('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'diagnose', configText }),
    });
    return res.json();
  }

  async function testAgp() {
    if (!agpConfigText.trim()) return;
    setAgpTesting(true);
    setAgpTestResult(null);
    try {
      const data = await testConfig(agpConfigText);
      setAgpTestResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setAgpTestResult('Network error: ' + err.message);
    } finally {
      setAgpTesting(false);
    }
  }

  async function testLatch(index) {
    const text = latchConfigs[index];
    if (!text.trim()) return;
    setLatchTesting((arr) => arr.map((v, i) => (i === index ? true : v)));
    setLatchTestResults((arr) => arr.map((v, i) => (i === index ? null : v)));
    try {
      const data = await testConfig(text);
      setLatchTestResults((arr) => arr.map((v, i) => (i === index ? JSON.stringify(data, null, 2) : v)));
    } catch (err) {
      setLatchTestResults((arr) => arr.map((v, i) => (i === index ? 'Network error: ' + err.message : v)));
    } finally {
      setLatchTesting((arr) => arr.map((v, i) => (i === index ? false : v)));
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;
    if (!groqKey && !geminiKey) {
      setShowSettings(true);
      return;
    }

    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(groqKey ? { 'x-groq-key': groqKey } : {}),
          ...(geminiKey ? { 'x-gemini-key': geminiKey } : {}),
        },
        body: JSON.stringify({
          messages: next
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: m.content })),
          agpConfigText: agpConfigText.trim() || undefined,
          latchConfigTexts: latchConfigs.map((c) => c.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, { role: 'system', content: `Error: ${data.error}` }]);
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: data.reply, tools: data.toolCalls || [], provider: data.provider }]);
      }
    } catch (err) {
      setMessages((m) => [...m, { role: 'system', content: `Network error: ${err.message}` }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app">
      <div className="header">
        <div className="brand">
          <a
            href="https://agp.onlatch.com/tracks?id=f4c530b0-b17f-4fb0-a55e-8c400fa248b3"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="AGP tracks"
          >
            🏁
          </a>
          <span>AGP chat</span>
        </div>
        <button className="iconBtn" onClick={() => setShowSettings(true)}>⚙</button>
      </div>

      <div className="messages" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  table: ({ children }) => <div className="tableWrap"><table>{children}</table></div>,
                }}
              >
                {displayText(m.content)}
              </ReactMarkdown>
            ) : (
              displayText(m.content)
            )}
            {m.tools?.length > 0 && (
              <div className="toolNote">
                                {m.tools?.length > 0 && 'Ran: ' + Object.entries(m.tools.reduce((a, t) => ({ ...a, [t]: (a[t] || 0) + 1 }), {})).map(([t, n]) => `${t} ×${n}`).join(', ')}
              </div>
            )}
          </div>
        ))}
        {sending && <div className="msg assistant">…</div>}
      </div>

      <div className="inputBar">
        <textarea
          rows={1}
          placeholder="Message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button className="sendBtn" onClick={sendMessage} disabled={sending || !input.trim()}>
          Send
        </button>
      </div>

      {showSettings && (
        <div className="modalOverlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Your keys</h2>
            <div className="field">
              <label>Groq API key</label>
              <input
                type="password"
                placeholder="gsk_…"
                value={groqKey}
                onChange={(e) => setGroqKey(e.target.value)}
              />
              <div className="hint">Stored only in this browser. Never sent anywhere but api.groq.com.</div>
            </div>

            <div className="field">
              <label>Gemini API key (optional)</label>
              <input
                type="password"
                placeholder="AIza…"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
              />
              <div className="hint">
                Free from Google AI Studio. If you add this too, the chat automatically switches to
                Gemini the moment Groq hits its rate limit, instead of failing. With only one key
                filled in, that one is used.
              </div>
            </div>

            <div className="field">
              <label>AGP MCP config (optional)</label>
              <textarea
                rows={9}
                placeholder={AGP_PLACEHOLDER}
                value={agpConfigText}
                onChange={(e) => setAgpConfigText(e.target.value)}
                style={boxStyle}
              />
              <div className="hint">
                Paste the exact mcpServers JSON block you already have. Read tools (balance, race status)
                run automatically; anything that spends real money asks you to confirm in chat first.
              </div>
              {agpConfigText.trim() && (
                <button className="closeBtn" style={{ marginTop: 10 }} onClick={testAgp} disabled={agpTesting}>
                  {agpTesting ? 'Testing…' : 'Test connection'}
                </button>
              )}
              {agpTestResult && <pre style={resultStyle}>{agpTestResult}</pre>}
            </div>

            {Array.from({ length: LATCH_SLOTS }, (_, i) => (
              <div className="field" key={i}>
                <label>Latch {i + 1} MCP config (optional)</label>
                <textarea
                  rows={9}
                  placeholder={LATCH_PLACEHOLDER}
                  value={latchConfigs[i]}
                  onChange={(e) =>
                    setLatchConfigs((arr) => arr.map((v, idx) => (idx === i ? e.target.value : v)))
                  }
                  style={boxStyle}
                />
                {i === 0 && (
                  <div className="hint">
                    Latch runs as a local process (stdio), not a hosted server — this works when you run
                    the app yourself (npm run dev), but may not work once deployed to Vercel, since
                    serverless functions generally can't reliably spawn and install a fresh process per
                    request. Test locally first.
                  </div>
                )}
                {latchConfigs[i].trim() && (
                  <button
                    className="closeBtn"
                    style={{ marginTop: 10 }}
                    onClick={() => testLatch(i)}
                    disabled={latchTesting[i]}
                  >
                    {latchTesting[i] ? 'Testing…' : 'Test connection'}
                  </button>
                )}
                {latchTestResults[i] && <pre style={resultStyle}>{latchTestResults[i]}</pre>}
              </div>
            ))}

            <button className="primaryBtn" onClick={saveSettings}>Save</button>
            <button className="closeBtn" onClick={clearChat}>Clear chat</button>
            <button className="closeBtn" onClick={() => setShowSettings(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}