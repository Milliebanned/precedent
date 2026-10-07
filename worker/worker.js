// Precedent's language layer: a Cloudflare Worker that keeps the model key off the public page.
// It does two jobs and no arithmetic. "parse" turns a trade idea in plain English into a structured setup.
// "memo" writes the research memo from numbers the page has already computed.
//
//   cd worker && npx wrangler deploy
//   npx wrangler secret put LLM_API_KEY      (LLM_BASE_URL and LLM_MODEL are in wrangler.toml)

const TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "SPY", "QQQ", "COIN"];
const ORIGINS = ["https://milliebanned.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];
const PER_MINUTE = 12;       // model calls per visitor per minute
const seen = new Map();   // ip -> recent request times (per isolate; a soft limit)

const PARSE = `You are the intake desk of Precedent, a research workbench for traders of tokenized US stocks on Bitget (rTokens), which trade 24/7 while the US cash market is closed (16:00 to 09:30 New York, and weekends).
The trader describes a trade idea for a closed-market window. Turn it into a setup the workbench can test against history. You never judge the idea and never do arithmetic.

Reply with one JSON object and nothing else.

A question about whether to make a trade ("should I buy Tesla tonight?", "is it a good time to short COIN?") is a trade idea: test it.
If the message is a trade idea, or changes the current setup ("what if 3x", "wait until 2 hours before the open", "try TSLA instead"), reply:
{"kind":"setup","setup":{
 "ticker": one of ${TICKERS.join(", ")},
 "side": "long" or "short",
 "leverage": number, default 1,
 "size_usdt": position size in USDT, default 1000,
 "window": "next" (the current or coming closed window; the default), "overnight" or "weekend",
 "entry": {"ref":"now"} or {"ref":"after_close","hours":h} or {"ref":"before_open","hours":h}. Use "now" when they speak of acting now or give no time. "At the close" is after_close 0.
 "hold_hours": null to hold until 15 minutes after the cash open (the default), or a number of hours,
 "stop_pct": null, or a stop-loss distance in percent, e.g. 2,
 "own": null, or [min,max] for the stock's own move since the close at entry time, in units of that stock's normal day. Either bound may be null. "Down big"/"sold off"/"dip" is [null,-0.5]; "up big" is [0.5,null]; "quiet" is [-0.3,0.3]. A percent move the trader states goes in "own_pct" instead.
 "own_pct": null, or [min,max] in percent, only when the trader gives the stock's move in percent,
 "btc": null, or [min,max] for Bitcoin's move since the close at entry time, in percent. "Bitcoin is dumping" is [null,-1]; "Bitcoin down more than 2%" is [null,-2]; "Bitcoin is up" is [1,null],
 "earnings": true if the idea is about an earnings night, false if they exclude earnings nights, else null,
 "like_now": true if they want past windows that look like current conditions ("like right now", "given where things are"), else false. When true, leave own and btc null: the page fills them from live prices,
 "thesis": the trader's reason in at most 20 words, in their own terms, or ""
},"say":"one sentence, at most 25 words, restating the setup you will test"}
When the message changes an existing setup, start from "current setup" in the context and change only what was asked.

If the message is a question about the results on screen, answer it from "results on screen" only, in at most 90 words, plain English, no advice to buy or sell:
{"kind":"answer","answer":"..."}

If it is neither, or names a stock outside the ten, reply {"kind":"answer","answer":"..."} saying briefly what Precedent can test, with one example.`;

const MEMO = `You write the research memo for Precedent, a workbench that stress-tests a trade idea on tokenized US stocks (Bitget rTokens) against past closed-market windows. The human trader decides; you never tell them to buy or sell.
You get JSON: the setup, the trader's thesis and house rules, and numbers the workbench computed from Bitget 15-minute candles. Use only those numbers. Never invent a price, date, statistic or news item. Returns are net of a 0.30% round trip (0.10% fee and 0.05% slippage per side). "precedents" are past windows that match the setup's conditions; "baseline" is the same trade on every window with no conditions; "peers" is the same setup on the other nine tokens.

Write in plain English, 150 to 210 words, in exactly this shape:
**Read:** two sentences. What history says about this setup, with the sample size, win rate and median.
**Does the condition add anything?** one or two sentences comparing precedents with the baseline, and with peers if given.
**What could hurt:** two or three bullets starting with "- ", each naming one stress test result with its number. Include any house rule that is broken.
**Before you click:** two or three bullets starting with "- ", each a concrete check or a change to the setup (smaller size, lower leverage, a stop, a different entry time) that the numbers support.
If there are fewer precedents than house_rules.min_precedents, say plainly that the sample is too thin to lean on, and lead with that. If results held early but not in the recent half, say so. Do not use the words "should", "recommend", or "guarantee".`;

function cors(origin) {
  const ok = ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin || "");
  return {
    "Access-Control-Allow-Origin": ok ? origin : ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function reply(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });
}

function limited(key, max) {
  const now = Date.now(), times = (seen.get(key) || []).filter((t) => now - t < 60000);
  times.push(now);
  seen.set(key, times);
  if (seen.size > 5000) seen.clear();
  return times.length > max;
}

async function chat(env, messages, maxTokens, json) {
  const res = await fetch(env.LLM_BASE_URL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
    // Qwen's thinking mode takes over a minute here and adds nothing: both jobs are short and tightly specified.
    body: JSON.stringify({ model: env.LLM_MODEL, temperature: 0.2, max_tokens: maxTokens, messages, enable_thinking: false,
      ...(json ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  const out = await res.json();
  return (out.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

const clip = (v, n) => JSON.stringify(v ?? null).slice(0, n);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return reply({ service: "precedent", models: env.LLM_MODEL }, 200, origin);
    const ip = request.headers.get("CF-Connecting-IP") || "?";
    let body;
    try { body = await request.json(); } catch { return reply({ error: "Bad request." }, 400, origin); }

    if (limited(ip, PER_MINUTE)) return reply({ error: "Too many requests. Wait a minute." }, 429, origin);

    try {
      if (body.mode === "parse") {
        const question = String(body.question || "").slice(0, 500).trim();
        if (!question) return reply({ error: "Type a trade idea." }, 400, origin);
        const context = `Context (JSON):\n{"now":${clip(body.now, 600)},"current setup":${clip(body.setup, 900)},"results on screen":${clip(body.results, 3500)}}`;
        const text = await chat(env, [
          { role: "system", content: PARSE },
          { role: "system", content: context },
          { role: "user", content: question },
        ], 900, true);
        const start = text.indexOf("{"), end = text.lastIndexOf("}");
        const out = JSON.parse(text.slice(start, end + 1));
        if (out.kind === "setup" && !TICKERS.includes(out.setup?.ticker)) {
          return reply({ kind: "answer", answer: `Precedent covers ten tokens: ${TICKERS.join(", ")}. Name one of them in the idea.` }, 200, origin);
        }
        return reply({ ...out, model: env.LLM_MODEL }, 200, origin);
      }
      if (body.mode === "memo") {
        const text = await chat(env, [
          { role: "system", content: MEMO },
          { role: "user", content: clip(body.brief, 9000) },
        ], 1100, false);
        return reply({ memo: text, model: env.LLM_MODEL }, 200, origin);
      }
    } catch (e) {
      return reply({ error: "The model did not answer. The numbers on the page do not depend on it; try again for the memo." }, 502, origin);
    }
    return reply({ error: "Unknown mode." }, 400, origin);
  },
};
