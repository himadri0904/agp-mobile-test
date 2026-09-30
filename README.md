# Groq Chat + AGP (mobile-first, bring-your-own-key)

A single chat box, deployable to Vercel, that anyone can open on their phone
and use with their own Groq API key. No hosting or setup required from your
users — they just visit the link, tap the gear icon, and paste in their keys.

## Deploy (one time, by you)

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com/new, import the repo, click Deploy. No env vars
   needed — Vercel auto-detects Next.js.
3. Share the resulting `*.vercel.app` link. That's the whole install step
   for your users.

## How keys work

- Each user's Groq key and AGP key are typed into the Settings panel and
  saved to `localStorage` **in their own browser only**.
- Every request sends the key in a request header to a serverless function
  (`/api/chat` or `/api/mcp`) which forwards it upstream and never writes it
  to disk, a database, or a log.
- You (the deployer) never see anyone's keys.

## How it works — just chat, no buttons

There's one chat box. `pages/api/chat.js` gives the model (via Groq's
function-calling) direct access to every AGP tool that looks read-only
(balance, race status, standings) — it calls those on its own whenever
they'd help answer you, no extra taps needed.

Any AGP tool whose name/description mentions betting, staking, submitting,
or guessing is treated differently: the model can't call it directly. It
can only call `propose_agp_action`, which records what it wants to do and
makes the model explain the proposal to you in plain English. Nothing is
sent to AGP at that point. Only if your *next* message clearly confirms
("yes", "go ahead", etc.) does the model get access to
`confirm_and_run_agp_action`, which actually executes it.

This is intentional and shouldn't be removed — it keeps a human in the loop
for anything that moves real value, without making you click through a
separate panel for it. `pages/api/mcp.js` still exists as a raw testing
route (curl-friendly) but the chat UI no longer uses it.

## Local dev

```bash
npm install
npm run dev
```

Open http://localhost:3000, add your keys in Settings.

## Structure

- `pages/index.js` — the whole frontend (chat + settings + AGP panel)
- `pages/api/chat.js` — stateless proxy to `api.groq.com/openai/v1/chat/completions`
- `pages/api/mcp.js` — stateless proxy to the AGP MCP endpoint
- `styles/globals.css` — mobile-first dark theme, safe-area aware
