<img src="docs/mark.svg" width="64" alt="Precedent logo">

# Precedent

**Before you open the position, see how the same setup ended every other time.**

Precedent is a research workbench for people who trade tokenized US stocks (Bitget rTokens) while the US cash market
is closed. You type a trade idea in plain English. It retrieves every past night or weekend that looked the same,
shows how each one ended, runs a set of stress tests, and writes a short memo. The trader decides; Precedent never
places an order.

Bitget AI Base Camp Hackathon S2 · AI Trading Desk · Decision Stress Testing.

- **Live demo (no login):** https://milliebanned.github.io/precedent/
- **Product guide:** https://milliebanned.github.io/precedent/guide.html ([PDF](https://milliebanned.github.io/precedent/precedent-guide.pdf))
- **One full research task, ready to run:** [Short COIN two hours before the open when Bitcoin is down more than 1%](https://milliebanned.github.io/precedent/?q=Short%20COIN%202%20hours%20before%20the%20open%20if%20Bitcoin%20is%20down%20more%20than%201%25%2C%203x%2C%202%2C000%20USDT)

## The thesis

A closed-market trade idea usually arrives as a story: "Bitcoin is dumping, so Coinbase will open lower." The story
is rarely checked against the record, because checking takes an evening of spreadsheet work and the open is in two
hours.

This project began as exactly that kind of story. We tested 144 versions of "follow Bitcoin's overnight move into the
open" and picked the best one on the first 45 sessions: trade COIN two hours before the open. It returned +2.19%
with a Sharpe of 5.56. On the next month, which it had never seen, it returned −0.04%
([`results/report.json`](results/report.json), code in [`precedent/backtest.py`](precedent/backtest.py)).

So the tool is built around three questions a trader should be able to answer in under a minute, before the click:

1. **What is the base rate?** How did this exact setup end, every time it has happened?
2. **Does my condition add anything?** Is that better than the same trade with no conditions at all?
3. **Does it still work?** Did it hold up in the recent half of the record, or only early on?

## One research task, from question to insight

> *Short COIN 2 hours before the open if Bitcoin is down more than 1%, 3x, 2,000 USDT*

1. **Read the idea.** Qwen turns the sentence into a setup: COIN, short, 2,000 USDT, 3×, overnight, entry two hours
   before the open, Bitcoin −1% or lower since the close. Every part appears as an editable control.
2. **Pull live data.** Current COIN and Bitcoin prices from Bitget, to place "now" inside the current window.
3. **Retrieve precedents.** Of 48 overnight windows on record, 8 match. Each is a dot on the chart with its date.
4. **Distribution.** 75% made money, median +1.30% after costs. The same trade with no conditions won 48%, median
   −0.19%, so the Bitcoin condition is doing the work. On the other nine tokens the same setup had a median of −0.13%:
   the effect is specific to COIN.
5. **Stress tests.** Worst precedent −1.64%. Worst night on record for this trade −5.93%. With volatility doubled,
   −2.99%. Liquidation at 3× is 7.2 normal days away and was never reached. **Recent half: +2.46% a trade in the first
   four precedents, +0.14% in the latest four.** The live order book costs 0.08% to fill 2,000 USDT, above the 0.05%
   assumed.
6. **House rules.** The trader's own limit is 10 precedents; this has 8, so the verdict is "thin record".
7. **Memo.** Qwen writes it from those numbers only: what history says, whether the condition adds anything, what
   could hurt, and what to check before clicking.
8. **Follow up in plain English.** "What if I wait until 1 hour before the open and use 5x?" re-runs it.
   "Why is the recent half weaker?" is answered from the results on screen.
9. **Review.** Save the idea to the notebook. After the window closes it shows what actually happened, and whether
   that was inside the range the precedents suggested.

(Numbers as of 7 Oct 2026. The record grows by one window every trading day.)

## Features

| | |
|---|---|
| Plain-English input | Trade ideas, changes to the current setup, and questions about the results |
| Editable setup | Token, side, size, leverage, window, entry time, the token's own move, Bitcoin's move, earnings, stop |
| "Like right now" | Matches past windows to the live move of the token and of Bitcoin since the close |
| Precedent retrieval | Every closed-market window for ten rTokens since July 2026, as 30-minute price paths with highs and lows |
| Distribution | Result of every precedent after costs, win rate, median, 1-in-20 bad case, the ride from entry to exit |
| Baseline and peers | The same trade with no conditions, and the same setup on the other nine tokens |
| Stress tests | Worst precedent, worst night on record, doubled volatility, liquidation distance, stop-outs, cost share, recent half, earnings due, live order-book cost |
| House rules | Your own maximum loss, maximum leverage and minimum sample; every idea is checked against them |
| Memo | Written by Qwen from the computed numbers only |
| Notebook | Saved ideas, compared with what actually happened once the window closed |

## Built with

| Need | Source |
|---|---|
| History | Bitget public market data: 15-minute candles for 10 rTokens and BTCUSDT |
| Live prices and order book | Bitget public market data, called from the browser |
| Earnings dates | `bitget-mcp-server` |
| Reading the idea, the memo, follow-up answers | Qwen 3.8 Max through the hackathon gateway, behind a Cloudflare Worker ([`worker/`](worker)) that keeps the key off the page |
| Daily refresh | GitHub Actions ([`.github/workflows`](.github/workflows)) |

The model does no arithmetic. Every number on the page is computed in the browser ([`docs/app.js`](docs/app.js)) from
[`docs/data.json`](docs/data.json), so the page still works, with a built-in parser and a plain summary, if the model
is unreachable.

## Assumptions and limits

- **The record is short:** about 60 windows per token, from 13 July 2026. Most conditional setups have fewer than
  20 precedents, and the page says so instead of hiding it.
- **Costs:** 0.10% fee and 0.05% slippage per side, 0.30% a round trip. The live order-book test shows when your size
  would cost more.
- **Prices are spot rTokens.** Shorts and leverage assume the matching Bitget stock futures. Funding is not modelled.
- **Stops** are assumed to fill at their level. **Liquidation** is approximated as an adverse move of 1 ÷ leverage.
- Before August 2026 the tokens did not trade on weekends; those windows are left out.
- History is not a forecast, and this is not financial advice.

## Run it

Python 3.12, standard library only.

```
python -m precedent.data          # refresh the candles
python -m precedent.earnings      # refresh the earnings calendar
python -m precedent.build         # rebuild docs/data.json
python -m unittest discover tests
python -m http.server 8000 -d docs

cd worker && npx wrangler dev     # the language layer, with LLM_API_KEY in worker/.dev.vars
# then open http://localhost:8000/?api=http://localhost:8787

python -m precedent.backtest select   # the Bitcoin study: pick a rule on the first 45 sessions
python -m precedent.backtest test     # and run it once on the unseen month
```

## Where things are

- `docs/` — the workbench: `index.html`, `app.js` (retrieval, statistics, stress tests, charts), `data.json`.
- `precedent/` — candle download, market hours, earnings, the record builder, and the Bitcoin study.
- `worker/` — the Cloudflare Worker that talks to Qwen.
- `data/` — cached candles and earnings dates. `results/` — the Bitcoin study's output.
