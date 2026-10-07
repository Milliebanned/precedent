/* Precedent: every number on the page is computed here, in the browser, from data.json (Bitget 15-minute
   candles cut into closed-market windows) and Bitget's live public API. The model only reads the idea and
   writes the memo. */
(function () {
  'use strict';

  var API = new URLSearchParams(location.search).get('api') || 'https://precedent-desk.pervigil.workers.dev';
  var BITGET = 'https://api.bitget.com/api/v2/spot/market/';
  var H = 3600000, STEP = 900000;
  var D = null, U = 1e-5, COST = 0.0015;
  var S = { setup: null, plan: null, res: null, live: null, memoTimer: 0, run: 0 };
  var $ = function (id) { return document.getElementById(id); };

  var EXAMPLES = [
    ['Short COIN when Bitcoin dumps', 'Short COIN 2 hours before the open if Bitcoin is down more than 1%, 3x, 2,000 USDT'],
    ['Long NVDA over the weekend', 'Long NVDA over the weekend with 2,000 USDT'],
    ['Buy the TSLA dip with a 2% stop', 'TSLA sold off hard after the close. Buy the dip 4 hours before the open with a 2% stop'],
    ['Long QQQ, like right now', 'Long QQQ now, given where things are right now'],
  ];

  /* ---------- small helpers ---------- */
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function pct(x, d) { return x == null || isNaN(x) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d == null ? 2 : d) + '%'; }
  function usd(x) { return x == null || isNaN(x) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: Math.abs(x) < 100 ? 2 : 0 }) + ' USDT'; }
  function num(x) { return Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function day(id) { return new Date(id + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function times(v) { return (v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '×'; }
  function hrs(h) { return (Math.round(h * 2) / 2) + 'h'; }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function range(v) {
    if (!Array.isArray(v) || (v[0] == null && v[1] == null)) return null;
    var a = v[0] == null ? null : Number(v[0]), b = v[1] == null ? null : Number(v[1]);
    return (a != null && isNaN(a)) || (b != null && isNaN(b)) ? null : [a, b];
  }
  function inRange(x, r) { return !r || ((r[0] == null || x >= r[0]) && (r[1] == null || x <= r[1])); }

  /* ---------- house rules ---------- */
  var RULES = { loss: 50, lev: 3, n: 10 };
  try { Object.assign(RULES, JSON.parse(localStorage.getItem('precedent.rules') || '{}')); } catch (e) {}
  function showRules() {
    $('r-loss').value = RULES.loss; $('r-lev').value = RULES.lev; $('r-n').value = RULES.n;
    $('rules-sum').textContent = 'max loss ' + RULES.loss + ' USDT · max ' + RULES.lev + '× · min ' + RULES.n + ' precedents';
  }
  ['loss', 'lev', 'n'].forEach(function (k) {
    $('r-' + k).addEventListener('change', function () {
      var v = Number(this.value);
      if (v > 0) RULES[k] = v;
      try { localStorage.setItem('precedent.rules', JSON.stringify(RULES)); } catch (e) {}
      showRules();
      if (S.setup) analyse(true);
    });
  });

  /* ---------- live Bitget data ---------- */
  /* fetch that gives up: a request that hangs must never leave the page looking stuck */
  function timed(url, opts, ms) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms);
    return fetch(url, Object.assign({ signal: c.signal }, opts || {})).finally(function () { clearTimeout(t); });
  }
  function post(body, ms) {
    return timed(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, ms).then(function (r) { return r.json(); });
  }
  function unwrap(j) { if (!j || j.code !== '00000') throw new Error((j && j.msg) || 'bitget'); return j.data; }
  /* Bitget's public API, straight from the browser. Some networks cannot reach it; after one failure the page
     stops trying for a while so nothing waits on it again. */
  var bitgetDown = 0;
  function bitget(path) {
    if (Date.now() - bitgetDown < 120000) return Promise.reject(new Error('bitget unreachable'));
    return timed(BITGET + path, null, 3500).then(function (r) { return r.json(); }).then(unwrap)
      .catch(function (e) { bitgetDown = Date.now(); throw e; });
  }
  function windowNow() {
    var now = Date.now(), up = D.upcoming;
    for (var i = 0; i < up.length; i++) {
      if (up[i].close <= now && now < up[i].open) return { active: true, w: up[i] };
      if (up[i].close > now) return { active: false, w: up[i] };
    }
    return { active: false, w: up[up.length - 1] || null };
  }
  function sinceClose(rows, closeMs) {
    rows = rows.map(function (r) { return [Number(r[0]), Number(r[4])]; }).sort(function (a, b) { return a[0] - b[0]; });
    var ref = null;
    rows.forEach(function (r) { if (r[0] + STEP <= closeMs && closeMs - r[0] - STEP <= H) ref = r[1]; });
    var last = rows.length ? rows[rows.length - 1][1] : null;
    return { price: last, move: ref && last ? last / ref - 1 : null };
  }
  /* Where this token and Bitcoin stand in the current closed window. Resolves even when Bitget is unreachable. */
  function liveState(ticker) {
    var wn = windowNow(), out = { active: wn.active, w: wn.w, ticker: ticker, ok: false };
    if (!wn.w) return Promise.resolve(out);
    out.hoursToOpen = (wn.w.open - Date.now()) / H;
    out.hoursSinceClose = (Date.now() - wn.w.close) / H;
    return Promise.all([
      bitget('candles?symbol=R' + ticker + 'USDT&granularity=15min&limit=300'),
      bitget('candles?symbol=BTCUSDT&granularity=15min&limit=300'),
    ]).then(function (r) {
      var own = sinceClose(r[0], wn.w.close), btc = sinceClose(r[1], wn.w.close);
      out.ok = true; out.price = own.price;
      if (wn.active) {
        out.move = own.move; out.btc = btc.move;
        out.z = own.move == null ? null : own.move / (D.vol_now[ticker] * U);
      }
      return out;
    }).catch(function () { return out; });
  }
  function bookCost(ticker, side, size) {
    return bitget('orderbook?symbol=R' + ticker + 'USDT&type=step0&limit=150').then(function (b) {
      var levels = (side > 0 ? b.asks : b.bids).map(function (l) { return [Number(l[0]), Number(l[1])]; });
      if (!levels.length) throw new Error('empty');
      var mid = b.asks.length && b.bids.length ? (Number(b.asks[0][0]) + Number(b.bids[0][0])) / 2 : levels[0][0], left = size, paid = 0, qty = 0;
      for (var i = 0; i < levels.length && left > 0; i++) {
        var take = Math.min(left, levels[i][0] * levels[i][1]);
        paid += take; qty += take / levels[i][0]; left -= take;
      }
      var spread = b.asks.length && b.bids.length ? Number(b.asks[0][0]) / Number(b.bids[0][0]) - 1 : null;
      return { filled: paid, short: left > 0, slip: Math.abs(paid / qty / mid - 1), spread: spread };
    });
  }

  /* ---------- the setup ---------- */
  function normalise(s, prev) {
    s = s || {}; prev = prev || {};
    var e = s.entry || {};
    return {
      ticker: D.tickers.indexOf(s.ticker) >= 0 ? s.ticker : (prev.ticker || 'NVDA'),
      side: s.side === 'short' || s.side === -1 ? -1 : 1,
      lev: clamp(Number(s.leverage || s.lev) || 1, 1, 50),
      size: clamp(Number(s.size_usdt || s.size) || 1000, 10, 1e7),
      window: ['overnight', 'weekend'].indexOf(s.window) >= 0 ? s.window : 'next',
      entry: { ref: ['after_close', 'before_open'].indexOf(e.ref) >= 0 ? e.ref : 'now', hours: clamp(Number(e.hours) || 0, 0, 64) },
      hold: Number(s.hold_hours || s.hold) > 0 ? Number(s.hold_hours || s.hold) : null,
      stop: Number(s.stop_pct || s.stop) > 0 ? Number(s.stop_pct || s.stop) : null,
      own: range(s.own), ownPct: range(s.own_pct || s.ownPct), btc: range(s.btc),
      earnings: s.earnings === true || s.earnings === false ? s.earnings : null,
      likeNow: !!(s.like_now || s.likeNow),
      thesis: String(s.thesis || '').slice(0, 200),
    };
  }
  /* Last-resort reader, used only when the model cannot be reached. */
  function localParse(q, prev) {
    var t = q.toUpperCase(), s = prev ? JSON.parse(JSON.stringify(prev)) : {};
    var names = { NVIDIA: 'NVDA', TESLA: 'TSLA', APPLE: 'AAPL', MICROSOFT: 'MSFT', AMAZON: 'AMZN', GOOGLE: 'GOOGL', COINBASE: 'COIN', NASDAQ: 'QQQ' };
    D.tickers.forEach(function (k) { if (new RegExp('\\b' + k + '\\b').test(t)) s.ticker = k; });
    Object.keys(names).forEach(function (k) { if (t.indexOf(k) >= 0) s.ticker = names[k]; });
    if (!s.ticker) return null;
    if (/\b(SHORT|SELL|FADE)\b/.test(t)) s.side = 'short'; else if (/\b(LONG|BUY)\b/.test(t)) s.side = 'long';
    var m;
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*X\b/))) s.leverage = Number(m[1]);
    if ((m = t.match(/([\d,]+(?:\.\d+)?)\s*(?:USDT|USD|\$)/)) || (m = t.match(/\$\s*([\d,]+)/))) s.size_usdt = Number(m[1].replace(/,/g, ''));
    if (/WEEKEND/.test(t)) s.window = 'weekend';
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:H|HOURS?)\s*BEFORE/))) s.entry = { ref: 'before_open', hours: Number(m[1]) };
    else if ((m = t.match(/(\d+(?:\.\d+)?)\s*(?:H|HOURS?)\s*AFTER/))) s.entry = { ref: 'after_close', hours: Number(m[1]) };
    if ((m = t.match(/(\d+(?:\.\d+)?)\s*%\s*STOP/))) s.stop_pct = Number(m[1]);
    if (/(BITCOIN|BTC)[^.]*\b(DOWN|DUMP|FALL|DROP)/.test(t)) s.btc = [null, -1];
    else if (/(BITCOIN|BTC)[^.]*\b(UP|RALL|PUMP)/.test(t)) s.btc = [1, null];
    if (/RIGHT NOW|LIKE NOW/.test(t)) s.like_now = true;
    if (prev) { s.leverage = s.leverage || prev.lev; s.size_usdt = s.size_usdt || prev.size; if (!s.side) s.side = prev.side; }
    return s;
  }

  /* Turn the setup into something the record can be searched with: which kind of window, which point on its
     path, and numeric conditions. "Now" and "like now" are filled in from live prices here. */
  function resolve(s, live) {
    var kind = s.window === 'next' ? (live.w ? live.w.kind : 'overnight') : s.window;
    var p = { kind: kind, notes: [], own: s.own, btc: s.btc, earnings: s.earnings };
    var liveFits = live.active && live.w.kind === kind;
    if (s.entry.ref === 'now') {
      p.ref = 'after_close';
      p.hours = liveFits ? Math.round(live.hoursSinceClose * 2) / 2 : 0;
      if (!liveFits) p.notes.push(live.active ? 'Entry is taken at the close, since this is a different kind of window from the current one.'
        : 'The US market is open now, so entry is taken at today’s close.');
    } else { p.ref = s.entry.ref; p.hours = s.entry.hours; }
    if (s.ownPct && !p.own) {
      var v = D.vol_now[s.ticker] * U * 100;
      p.own = [s.ownPct[0] == null ? null : s.ownPct[0] / v, s.ownPct[1] == null ? null : s.ownPct[1] / v];
    }
    if (s.likeNow) {
      if (liveFits && live.ok && live.z != null) {
        var tz = Math.max(0.3, Math.abs(live.z) * 0.5), b = (live.btc || 0) * 100, tb = Math.max(1, Math.abs(b) * 0.5);
        p.own = [live.z - tz, live.z + tz]; p.btc = [b - tb, b + tb];
        p.notes.push('“Like now” means: ' + s.ticker + ' ' + pct(live.move) + ' since the close (' + times(live.z) + ' its normal day) and Bitcoin ' + pct(live.btc) + '.');
      } else {
        p.notes.push(live.active ? 'Live prices could not be read, so “like now” was not applied.' : 'The US market is open, so there is no closed-market move to match yet. “Like now” was not applied.');
      }
    }
    return p;
  }
  function bucket(p, n) {
    return p.ref === 'before_open' ? clamp(n - Math.round(p.hours * 2), 0, n) : clamp(Math.round(p.hours * 2), 0, n - 1);
  }

  /* One past window, traded the setup's way. Returns null when the token had no price at the entry time. */
  function trade(s, p, sess, path) {
    var n = sess.btc.length - 1, k = bucket(p, n);
    if (path.c[k] == null) return null;
    var e = path.c[k] * U, held = s.hold ? Math.max(1, Math.round(s.hold * 2)) : 0;
    var kEnd = held && k + held < n ? k + held : n, toOpen = kEnd === n;
    var exit = toOpen ? path.x : path.c[kEnd];
    if (exit == null) return null;
    var rel = function (v) { return s.side * ((1 + v * U) / (1 + e) - 1); };
    var gross = rel(exit), adverse = Math.min(0, gross), ride = [0], j;
    for (j = k + 1; j <= kEnd; j++) {
      var ext = s.side > 0 ? path.lo[j] : path.hi[j];
      if (ext != null) adverse = Math.min(adverse, rel(ext));
      ride.push(path.c[j] == null ? null : rel(path.c[j]));
    }
    if (toOpen) ride.push(gross);
    var net = gross - 2 * COST, stopped = false, liq = false;
    if (s.stop && adverse <= -s.stop / 100) { stopped = true; net = -s.stop / 100 - 2 * COST; }
    if (s.lev > 1 && adverse <= -1 / s.lev) { liq = true; stopped = false; net = -1 / s.lev; }
    return { id: sess.id, kind: sess.kind, gross: gross, net: net, adverse: adverse, stopped: stopped, liq: liq, ride: ride,
      z: e / (path.vol * U), own: e, btc: sess.btc[k] == null ? null : sess.btc[k] * U, earn: !!path.earn, toOpen: toOpen };
  }
  function search(s, p, ticker, conditions) {
    var out = [], paths = D.paths[ticker];
    D.sessions.forEach(function (sess) {
      var path = paths[sess.id];
      if (!path || sess.kind !== p.kind) return;
      var t = trade(s, p, sess, path);
      if (!t) return;
      if (conditions) {
        if (!inRange(t.z, p.own)) return;
        if (p.btc && (t.btc == null || !inRange(t.btc * 100, p.btc))) return;
        if (p.earnings != null && t.earn !== p.earnings) return;
      }
      out.push(t);
    });
    return out;
  }
  function stats(list) {
    var nets = list.map(function (t) { return t.net; }).sort(function (a, b) { return a - b; });
    if (!nets.length) return { n: 0 };
    var worst = list.reduce(function (a, b) { return b.net < a.net ? b : a; });
    var best = list.reduce(function (a, b) { return b.net > a.net ? b : a; });
    return { n: nets.length, win: nets.filter(function (v) { return v > 0; }).length / nets.length, median: quantile(nets, 0.5), mean: mean(nets),
      p5: quantile(nets, 0.05), p95: quantile(nets, 0.95), worst: worst, best: best,
      adverse: mean(list.map(function (t) { return t.adverse; })), stopped: list.filter(function (t) { return t.stopped; }).length,
      liq: list.filter(function (t) { return t.liq; }).length };
  }
  function hasConditions(p) { return !!(p.own || p.btc || p.earnings != null); }

  function compute(s, p) {
    var hits = search(s, p, s.ticker, true), base = search(s, p, s.ticker, false);
    var peers = [];
    if (hasConditions(p)) D.tickers.forEach(function (t) { if (t !== s.ticker) peers = peers.concat(search(s, p, t, true)); });
    var st = stats(hits), half = Math.floor(hits.length / 2);
    var r = { hits: hits, st: st, base: stats(base), baseList: base, peers: stats(peers), conditional: hasConditions(p),
      early: stats(hits.slice(0, half)), late: stats(hits.slice(half)), windows: base.length };
    var bad = st.n >= 10 ? st.p5 : (st.n ? st.worst.net : null);
    r.badCase = bad; r.badLabel = st.n >= 10 ? '1-in-20 bad case' : 'Worst precedent';

    r.breaches = [];
    if (s.lev > RULES.lev) r.breaches.push('Leverage ' + s.lev + '× is above your limit of ' + RULES.lev + '×.');
    if (st.n && -st.worst.net * s.size > RULES.loss) r.breaches.push('The worst precedent lost ' + usd(st.worst.net * s.size).replace(/^−/, '') + ', more than your ' + RULES.loss + ' USDT limit.');
    if (st.n < RULES.n) r.breaches.push('Only ' + st.n + ' precedent' + (st.n === 1 ? '' : 's') + '; you trust ' + RULES.n + ' or more.');

    if (!st.n) r.verdict = { tone: 'warn', tag: 'No precedent', head: 'No past window on record matches this setup.', kind: 'none' };
    else if (st.n < RULES.n) r.verdict = { tone: 'warn', tag: 'Thin record', kind: 'thin',
      head: 'Only ' + st.n + ' past window' + (st.n === 1 ? ' matches' : 's match') + '. That is too few to lean on.' };
    else if (st.median <= 0 || st.win < 0.5) r.verdict = { tone: 'bad', tag: 'History is against it', kind: 'against',
      head: 'This setup made money in ' + Math.round(st.win * 100) + '% of ' + st.n + ' precedents, with a median of ' + pct(st.median) + ' after costs.' };
    else if (r.late.mean <= 0) r.verdict = { tone: 'warn', tag: 'Worked earlier, not lately', kind: 'fading',
      head: 'It paid in the early half of the record (' + pct(r.early.mean) + ' a trade) and not in the recent half (' + pct(r.late.mean) + ').' };
    else r.verdict = { tone: 'good', tag: 'History leans your way', kind: 'supports',
      head: Math.round(st.win * 100) + '% of ' + st.n + ' precedents made money, with a median of ' + pct(st.median) + ' after costs.' };

    r.tests = stress(s, p, r);
    return r;
  }

  function stress(s, p, r) {
    var st = r.st, tests = [], vol = D.vol_now[s.ticker] * U;
    if (st.n) {
      var w = st.worst;
      tests.push({ id: 'worst', name: 'Worst precedent', tone: -w.net * s.size > RULES.loss ? 'bad' : 'good', flag: -w.net * s.size > RULES.loss ? 'over your limit' : 'within your limit',
        value: usd(w.net * s.size) + ' (' + pct(w.net) + ')', text: 'The window that opened ' + day(w.id) + (w.liq ? ', where the position was liquidated.' : w.stopped ? ', where the stop was hit.' : '.') });
    }
    if (r.base.n) {
      var bw = r.base.worst;
      tests.push({ id: 'record', name: 'Worst night on record', tone: -bw.net * s.size > RULES.loss ? 'warn' : 'good', flag: 'any conditions',
        value: usd(bw.net * s.size) + ' (' + pct(bw.net) + ')', text: 'The same trade in the worst of all ' + r.base.n + ' ' + p.kind + ' windows, ' + day(bw.id) + (bw.earn ? ', an earnings night.' : '.') });
    }
    if (st.n) {
      var doubled = r.hits.map(function (t) { return 2 * t.gross - 2 * COST; }).sort(function (a, b) { return a - b; });
      var d = st.n >= 10 ? quantile(doubled, 0.05) : doubled[0];
      tests.push({ id: 'vol', name: 'Volatility doubles', tone: -d * s.size > RULES.loss ? 'warn' : 'good', flag: st.n >= 10 ? '1-in-20 case' : 'worst case',
        value: usd(d * s.size) + ' (' + pct(d) + ')', text: 'Every precedent replayed with moves twice as large.' });
    }
    if (s.lev > 1) {
      var dist = 1 / s.lev, n = r.baseList.filter(function (t) { return t.adverse <= -dist; }).length;
      tests.push({ id: 'liq', name: 'Liquidation at ' + s.lev + '×', tone: n ? 'bad' : dist / vol < 3 ? 'warn' : 'good', flag: n ? 'has happened' : 'never reached',
        value: pct(-dist, 1) + ' away', text: 'That is ' + (dist / vol).toFixed(1) + ' normal days for ' + s.ticker + '. The ride went that far against this trade in ' + n + ' of ' + r.base.n + ' windows. Maintenance margin makes it slightly closer.' });
    }
    if (s.stop && st.n) {
      tests.push({ id: 'stop', name: s.stop + '% stop', tone: st.stopped / st.n > 0.4 ? 'warn' : 'good', flag: st.stopped + ' of ' + st.n + ' hit',
        value: Math.round(st.stopped / st.n * 100) + '% stopped out', text: 'Assumes the stop fills at its level. A gap through it would cost more.' });
    }
    if (st.n) {
      var typical = quantile(r.hits.map(function (t) { return Math.abs(t.gross); }).sort(function (a, b) { return a - b; }), 0.5);
      var share = typical ? 2 * COST / typical : 9;
      tests.push({ id: 'cost', name: 'Costs', tone: share > 0.5 ? 'bad' : share > 0.25 ? 'warn' : 'good', flag: share > 0.5 ? 'heavy' : share > 0.25 ? 'noticeable' : 'light',
        value: Math.round(Math.min(share, 9.99) * 100) + '% of a typical move', text: 'The 0.30% round trip against a typical ' + pct(typical).replace('+', '') + ' move from entry to exit.' });
    }
    if (st.n >= 4) {
      var faded = r.early.mean > 0 && r.late.mean <= 0, both = r.early.mean > 0 && r.late.mean > 0;
      tests.push({ id: 'recent', name: 'Recent half', tone: both ? 'good' : faded ? 'bad' : 'warn', flag: both ? 'held up' : faded ? 'faded' : 'mixed',
        value: pct(r.early.mean) + ' → ' + pct(r.late.mean), text: 'Average per trade in the first ' + r.early.n + ' precedents, then in the latest ' + r.late.n + '. A pattern that paid only early may be gone.' });
    }
    if (r.conditional && r.base.n && st.n) {
      var lift = st.median - r.base.median;
      tests.push({ id: 'base', name: 'Does the condition help?', tone: lift > 0.001 ? 'good' : 'warn', flag: lift > 0.001 ? 'adds edge' : 'no clear edge',
        value: pct(st.median) + ' vs ' + pct(r.base.median), text: 'Median with your conditions, against the same trade on all ' + r.base.n + ' windows' +
          (r.peers.n ? '. On the other nine tokens the setup had a median of ' + pct(r.peers.median) + ' over ' + r.peers.n + ' windows.' : '.') });
    }
    var due = S.live && S.live.w && S.live.w.earn.indexOf(s.ticker) >= 0;
    var earnHits = r.hits.filter(function (t) { return t.earn; }).length;
    tests.push({ id: 'earn', name: 'Earnings', tone: due ? 'warn' : 'good', flag: due ? 'due this window' : 'none listed',
      value: due ? s.ticker + ' reports before the open' : 'No report before the next open', text: earnHits + ' of the ' + st.n + ' precedents were earnings nights. Dates from Bitget’s earnings calendar.' });
    tests.push({ id: 'book', name: 'Live order book', tone: '', flag: 'checking', value: '…', text: 'Walking the Bitget book for ' + num(s.size) + ' USDT.' });
    return tests;
  }

  /* ---------- describing a setup in words ---------- */
  function entryWords(p) {
    if (p.ref === 'before_open') return p.hours ? hrs(p.hours) + ' before the open' : 'at the open';
    return p.hours ? hrs(p.hours) + ' after the close' : 'at the close';
  }
  function rangeWords(r, unit) {
    var f = function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(unit === '%' ? 1 : 2).replace(/\.?0+$/, '') + unit; };
    if (r[0] != null && r[1] != null) return f(r[0]) + ' to ' + f(r[1]);
    return r[0] != null ? f(r[0]) + ' or higher' : f(r[1]) + ' or lower';
  }
  function describe(s, p) {
    var out = (s.side > 0 ? 'Long ' : 'Short ') + s.ticker + ', ' + num(s.size) + ' USDT' + (s.lev > 1 ? ' at ' + s.lev + '×' : '') + ', ' + p.kind +
      ', entered ' + entryWords(p) + ', ' + (s.hold ? 'held ' + hrs(s.hold) : 'held to 15 min after the open');
    var c = [];
    if (p.own) c.push(s.ticker + ' ' + rangeWords(p.own, '× normal day'));
    if (p.btc) c.push('Bitcoin ' + rangeWords(p.btc, '%'));
    if (p.earnings != null) c.push(p.earnings ? 'earnings nights only' : 'no earnings nights');
    if (s.stop) out += ', ' + s.stop + '% stop';
    return out + (c.length ? '. When: ' + c.join('; ') : '') + '.';
  }

  /* ---------- rendering ---------- */
  var tip = $('tip');
  function showTip(ev, text) {
    tip.textContent = text; tip.hidden = false;
    var x = ev.clientX + 14, y = ev.clientY + 14, r = tip.getBoundingClientRect();
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
  }
  function tipText(t, s) {
    return 'Opened ' + day(t.id) + ' (' + t.kind + (t.earn ? ', earnings' : '') + ')\n' + s.ticker + ' at entry ' + pct(t.own) + ' (' + times(t.z) + ' day)\n' +
      'Bitcoin at entry ' + pct(t.btc) + '\nResult ' + pct(t.net) + ' · ' + usd(t.net * s.size) + (t.liq ? '\nLiquidated' : t.stopped ? '\nStopped out' : '') + '\nWorst point ' + pct(t.adverse);
  }
  function hover(root) {
    root.addEventListener('mousemove', function (ev) {
      var el = ev.target.closest('[data-i]');
      document.querySelectorAll('.plot .on').forEach(function (n) { n.classList.remove('on'); });
      if (!el) { tip.hidden = true; return; }
      var t = S.res.hits[Number(el.dataset.i)];
      document.querySelectorAll('.plot [data-i="' + el.dataset.i + '"]:not(.hit)').forEach(function (n) { n.classList.add('on'); });
      showTip(ev, tipText(t, S.setup));
    });
    root.addEventListener('mouseleave', function () { tip.hidden = true; document.querySelectorAll('.plot .on').forEach(function (n) { n.classList.remove('on'); }); });
  }
  function ticks(lo, hi, want) {
    var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / want)));
    [2, 2.5, 2].forEach(function (m) { if (span / step > want * 1.5) step *= m; });
    var out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
    return out;
  }

  function drawDots(s, r) {
    var hits = r.hits, W = clamp($('dots').clientWidth || 720, 340, 720), padL = 14, padR = 14, R = 5.5;
    if (!hits.length) { $('dots').innerHTML = ''; return; }
    var lo = Math.min(0, r.st.worst.net), hi = Math.max(0, r.st.best.net), pad = (hi - lo) * 0.06 || 0.002;
    lo -= pad; hi += pad;
    var x = function (v) { return padL + (v - lo) / (hi - lo) * (W - padL - padR); };
    var binW = (R * 2 + 1) / (W - padL - padR) * (hi - lo), stacks = {}, top = 0;
    var pos = hits.map(function (t) {
      var b = Math.round(t.net / binW), k = stacks[b] = (stacks[b] || 0) + 1;
      top = Math.max(top, k);
      return { b: b, k: k };
    });
    var plotH = Math.max(46, top * (R * 2 + 1) + 8), Hh = plotH + 52, base = plotH + 22;
    var g = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="Each precedent’s result after costs">';
    if (r.st.n >= 10) g += '<rect class="band" x="' + x(r.st.p5) + '" y="20" width="' + (x(r.st.p95) - x(r.st.p5)) + '" height="' + (base - 20) + '"/>';
    ticks(lo, hi, W < 500 ? 4 : 7).forEach(function (v) {
      g += '<line class="' + (v === 0 ? 'zero' : 'grid') + '" x1="' + x(v) + '" x2="' + x(v) + '" y1="' + (v === 0 ? 20 : base) + '" y2="' + (base + 4) + '"/>' +
        '<text x="' + x(v) + '" y="' + (base + 18) + '" text-anchor="middle">' + pct(v, Math.abs(hi - lo) < 0.02 ? 2 : 1) + '</text>';
    });
    g += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + base + '" y2="' + base + '"/>';
    hits.forEach(function (t, i) {
      g += '<circle class="dot ' + (t.net > 0 ? 'gain' : 'loss') + '" style="--i:' + i + '" data-i="' + i + '" cx="' + x(pos[i].b * binW) + '" cy="' + (base - R - 1 - (pos[i].k - 1) * (R * 2 + 1)) + '" r="' + R + '"/>';
    });
    var mx = x(r.st.median), anchor = mx > W - 120 ? 'end' : mx < 120 ? 'start' : 'middle';
    g += '<line class="median" x1="' + mx + '" x2="' + mx + '" y1="16" y2="' + base + '"/><text class="lab" x="' + mx + '" y="10" text-anchor="' + anchor + '">median ' + pct(r.st.median) + '</text>';
    $('dots').innerHTML = g + '</svg><div class="legend"><span><i style="background:var(--gain)"></i>made money</span><span><i style="background:var(--loss)"></i>lost money</span>' +
      (r.st.n >= 10 ? '<span><i style="background:var(--mid);opacity:.4;border-radius:2px"></i>middle 90% of results</span>' : '') + '</div>';
    $('dots-sub').textContent = 'One dot per past window, after the 0.30% round trip. Hover a dot for the date and what the market looked like.';
  }

  function drawPaths(s, r) {
    var hits = r.hits, W = clamp($('paths').clientWidth || 720, 340, 720), Hh = 250, padL = 46, padR = 86, padT = 12, padB = 30;
    if (!hits.length) { $('paths').innerHTML = ''; return; }
    var len = Math.max.apply(null, hits.map(function (t) { return t.ride.length; })), lo = 0, hi = 0;
    hits.forEach(function (t) { t.ride.forEach(function (v) { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
    var pad = (hi - lo) * 0.08 || 0.002; lo -= pad; hi += pad;
    var toOpen = hits[0].toOpen, steps = len - 1, hoursAt = function (j) { return toOpen && j === steps ? (steps - 1) / 2 + 0.25 : j / 2; };
    var total = hoursAt(steps) || 0.5;
    var x = function (j) { return padL + hoursAt(j) / total * (W - padL - padR); }, y = function (v) { return padT + (hi - v) / (hi - lo) * (Hh - padT - padB); };
    var g = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="Each precedent from entry to exit, in the direction of the trade">';
    ticks(lo, hi, 5).forEach(function (v) {
      g += '<line class="' + (v === 0 ? 'zero' : 'grid') + '" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text x="' + (padL - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + pct(v, 1) + '</text>';
    });
    var hstep = total > 24 ? 12 : total > 8 ? 4 : total > 3 ? 1 : 0.5;
    if (W < 500) hstep *= 2;
    for (var h = 0; h <= total + 1e-9; h += hstep) {
      var px = padL + h / total * (W - padL - padR);
      g += '<text x="' + px + '" y="' + (Hh - 10) + '" text-anchor="middle">' + (h === 0 ? 'entry' : '+' + h + 'h') + '</text>';
    }
    g += '<text x="' + (W - padR) + '" y="' + (Hh - 10) + '" text-anchor="start" dx="6">' + (toOpen ? 'open +15m' : 'exit') + '</text>';
    var d = function (ride) {
      var out = '', pen = false;
      ride.forEach(function (v, j) { if (v == null) return; out += (pen ? 'L' : 'M') + x(j).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
      return out;
    };
    hits.forEach(function (t, i) {
      var p = d(t.ride);
      g += '<path class="line ' + (t.net > 0 ? 'gain' : 'loss') + '" pathLength="1" style="--i:' + i + '" data-i="' + i + '" d="' + p + '"/><path class="hit" data-i="' + i + '" d="' + p + '"/>';
    });
    if (hits.length >= 3) {
      var med = [];
      for (var j = 0; j < len; j++) {
        var vals = hits.map(function (t) { return t.ride[j]; }).filter(function (v) { return v != null; }).sort(function (a, b) { return a - b; });
        med.push(vals.length * 2 >= hits.length ? quantile(vals, 0.5) : null);
      }
      var last = med[len - 1];
      g += '<path class="median" pathLength="1" d="' + d(med) + '" pointer-events="none"/>';
      if (last != null) g += '<text class="lab" x="' + (W - padR + 6) + '" y="' + (y(last) + 4) + '">median ' + pct(last) + '</text>';
    }
    $('paths').innerHTML = g + '</svg><div class="legend"><span><i class="l" style="background:var(--gain)"></i>ended up after costs</span><span><i class="l" style="background:var(--loss)"></i>ended down</span>' +
      (hits.length >= 3 ? '<span><i class="l" style="background:var(--ink)"></i>median ride</span>' : '') + '</div>';
    $('paths-sub').textContent = 'Each line is one precedent, in the direction of your trade and before costs. Above zero is in your favour.';
  }

  function sel(name, value, options) {
    return '<select data-f="' + name + '" aria-label="' + name + '">' + options.map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (o[0] === value ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
    }).join('') + '</select>';
  }
  function preset(r, list, unit) {
    var key = r ? JSON.stringify(r) : 'any', found = list.some(function (o) { return o[0] === key; });
    return { value: key, options: found ? list : list.concat([[key, rangeWords(r, unit)]]) };
  }
  function drawSetup(s, p) {
    var entryKey = p.ref + ':' + p.hours, entries = [['after_close:0', 'At the close'], ['after_close:4', '4h after the close'], ['before_open:8', '8h before the open'],
      ['before_open:4', '4h before the open'], ['before_open:2', '2h before the open'], ['before_open:1', '1h before the open']];
    if (!entries.some(function (o) { return o[0] === entryKey; })) entries.push([entryKey, entryWords(p).replace(/^./, function (c) { return c.toUpperCase(); })]);
    var own = preset(p.own, [['any', 'Any'], ['[null,-0.5]', 'Down big'], ['[0.5,null]', 'Up big'], ['[-0.3,0.3]', 'Quiet']], '× day');
    var btc = preset(p.btc, [['any', 'Any'], ['[null,-2]', 'Down 2% or more'], ['[null,-1]', 'Down 1% or more'], ['[1,null]', 'Up 1% or more'], ['[2,null]', 'Up 2% or more']], '%');
    var chip = function (label, inner) { return '<label class="chip"><span>' + label + '</span>' + inner + '</label>'; };
    $('setup').innerHTML =
      chip('Token', sel('ticker', s.ticker, D.tickers.map(function (t) { return [t, t]; }))) +
      chip('Side', sel('side', String(s.side), [['1', 'Long'], ['-1', 'Short']])) +
      chip('Size', '<input data-f="size" type="number" min="10" step="100" value="' + s.size + '" aria-label="size in USDT">') +
      chip('Leverage', '<input data-f="lev" type="number" min="1" max="50" step="1" value="' + s.lev + '" aria-label="leverage">') +
      chip('Window', sel('kind', p.kind, [['overnight', 'Overnight'], ['weekend', 'Weekend']])) +
      chip('Entry', sel('entry', entryKey, entries)) +
      chip(s.ticker + ' so far', sel('own', own.value, own.options)) +
      chip('Bitcoin so far', sel('btc', btc.value, btc.options)) +
      chip('Earnings', sel('earnings', String(p.earnings), [['null', 'Any night'], ['true', 'Earnings nights'], ['false', 'No earnings nights']])) +
      chip('Stop %', '<input data-f="stop" type="number" min="0" step="0.5" value="' + (s.stop || '') + '" placeholder="none" aria-label="stop loss percent">');
  }
  $('setup').addEventListener('change', function (ev) {
    var f = ev.target.dataset.f, v = ev.target.value, s = S.setup;
    if (!f) return;
    if (f === 'ticker') s.ticker = v;
    if (f === 'side') s.side = Number(v);
    if (f === 'size') s.size = clamp(Number(v) || 1000, 10, 1e7);
    if (f === 'lev') s.lev = clamp(Number(v) || 1, 1, 50);
    if (f === 'kind') s.window = v;
    if (f === 'entry') s.entry = { ref: v.split(':')[0], hours: Number(v.split(':')[1]) };
    if (f === 'own') { s.own = v === 'any' ? null : JSON.parse(v); s.ownPct = null; s.likeNow = false; }
    if (f === 'btc') { s.btc = v === 'any' ? null : JSON.parse(v); s.likeNow = false; }
    if (f === 'earnings') s.earnings = v === 'null' ? null : v === 'true';
    if (f === 'stop') s.stop = Number(v) > 0 ? Number(v) : null;
    if (f === 'ticker') liveState(s.ticker).then(function (l) { S.live = l; analyse(true); }); else analyse(true);
  });

  function draw(s, p, r) {
    var st = r.st, v = r.verdict;
    drawSetup(s, p);
    var sub = '';
    if (r.conditional && r.base.n) sub += 'The same trade with no conditions won ' + Math.round(r.base.win * 100) + '% of ' + r.base.n + ' windows, median ' + pct(r.base.median) + '. ';
    sub += p.notes.join(' ');
    $('verdict').innerHTML = '<span class="tag ' + v.tone + '"><i></i>' + esc(v.tag) + '</span><h2>' + esc(v.head) + '</h2>' + (sub ? '<p>' + esc(sub) + '</p>' : '') +
      r.breaches.map(function (b) { return '<p class="breach">House rule: ' + esc(b) + '</p>'; }).join('');
    var tile = function (big, label, small) { return '<div class="tile"><b>' + big + '</b><span>' + label + '</span>' + (small ? '<small>' + small + '</small>' : '') + '</div>'; };
    $('tiles').innerHTML = !st.n ? tile('0', 'Precedents', 'of ' + r.windows + ' ' + p.kind + ' windows') :
      tile(st.n, 'Precedents', 'of ' + r.windows + ' ' + p.kind + ' windows') +
      tile(Math.round(st.win * 100) + '%', 'Made money', r.conditional && r.base.n ? 'no conditions: ' + Math.round(r.base.win * 100) + '%' : '') +
      tile(pct(st.median), 'Median result', usd(st.median * s.size)) +
      tile(pct(r.badCase), r.badLabel, usd(r.badCase * s.size)) +
      tile(pct(st.adverse), 'Typical worst point', 'on the way, before costs');
    $('file').hidden = false; $('waiting').hidden = true;
    document.querySelectorAll('.chart').forEach(function (c) { c.hidden = !st.n; });
    drawDots(s, r); drawPaths(s, r);
    drawTests(r.tests);
    var rows = r.hits.map(function (t) {
      return '<tr><td>' + day(t.id) + (t.earn ? ' · earnings' : '') + '</td><td>' + pct(t.own) + '</td><td>' + times(t.z) + '</td><td>' + pct(t.btc) + '</td><td>' + pct(t.adverse) + '</td><td class="' + (t.net > 0 ? 'g' : 'l') + '">' + pct(t.net) +
        '</td><td class="' + (t.net > 0 ? 'g' : 'l') + '">' + usd(t.net * s.size) + '</td><td>' + (t.liq ? 'liquidated' : t.stopped ? 'stopped' : '') + '</td></tr>';
    }).join('');
    $('table').innerHTML = '<thead><tr><th>Window opened</th><th>' + s.ticker + ' at entry</th><th>vs normal day</th><th>Bitcoin at entry</th><th>Worst point</th><th>Result</th><th>On ' + num(s.size) + ' USDT</th><th></th></tr></thead><tbody>' + rows + '</tbody>';
    $('table-wrap').hidden = !st.n;
    $('file-when').textContent = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
    window.dispatchEvent(new CustomEvent('precedent:hits', { detail: { ticker: s.ticker, ids: r.hits.map(function (t) { return t.id; }) } }));
  }
  function drawTests(tests) {
    $('stress').innerHTML = tests.map(function (t) {
      return '<div class="test ' + t.tone + '"><h4><span>' + esc(t.name) + '</span><em>' + esc(t.flag) + '</em></h4><b>' + esc(t.value) + '</b><p>' + esc(t.text) + '</p></div>';
    }).join('');
  }
  function markdown(text) {
    var html = '', list = false;
    esc(text).split(/\n+/).forEach(function (line) {
      line = line.trim().replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (!line) return;
      if (/^[-•]\s+/.test(line)) { if (!list) { html += '<ul>'; list = true; } html += '<li>' + line.replace(/^[-•]\s+/, '') + '</li>'; return; }
      if (list) { html += '</ul>'; list = false; }
      html += '<p>' + line.replace(/^#+\s*/, '') + '</p>';
    });
    return html + (list ? '</ul>' : '');
  }

  /* ---------- the memo ---------- */
  function brief(s, p, r) {
    var st = r.st, f = function (x) { return x == null ? null : Math.round(x * 10000) / 100; };
    var pack = function (q) { return q.n ? { windows: q.n, win_rate_pct: Math.round(q.win * 100), median_pct: f(q.median), mean_pct: f(q.mean) } : { windows: 0 }; };
    return {
      setup: describe(s, p), thesis: s.thesis || null, position_usdt: s.size, leverage: s.lev,
      house_rules: { max_loss_usdt: RULES.loss, max_leverage: RULES.lev, min_precedents: RULES.n, broken: r.breaches },
      verdict: r.verdict.tag,
      precedents: st.n ? Object.assign(pack(st), { bad_case_label: r.badLabel, bad_case_pct: f(r.badCase), worst_pct: f(st.worst.net), worst_date: st.worst.id, best_pct: f(st.best.net),
        typical_worst_point_pct: f(st.adverse), stopped_out: st.stopped, liquidated: st.liq, first_half_mean_pct: f(r.early.mean), recent_half_mean_pct: f(r.late.mean) }) : { windows: 0 },
      baseline: pack(r.base), peers: r.conditional ? pack(r.peers) : null,
      stress_tests: r.tests.filter(function (t) { return t.id !== 'book' || t.value !== '…'; }).map(function (t) { return { test: t.name, result: t.value, flag: t.flag, note: t.text }; }),
      now: S.live && S.live.active && S.live.ok ? { token_move_since_close_pct: f(S.live.move), bitcoin_move_since_close_pct: f(S.live.btc), hours_to_open: Math.round(S.live.hoursToOpen * 10) / 10 } : 'US cash market is open',
      notes: p.notes,
    };
  }
  function localMemo(s, p, r) {
    var st = r.st;
    if (!st.n) return '**Read:** No past window matches, so there is nothing to lean on. Loosen a condition or change the entry time.';
    return '**Read:** ' + r.verdict.head + '\n**What could hurt:**\n' + r.tests.slice(0, 4).map(function (t) { return '- ' + t.name + ': ' + t.value + ' (' + t.flag + ').'; }).join('\n') +
      (r.breaches.length ? '\n' + r.breaches.map(function (b) { return '- House rule: ' + b; }).join('\n') : '');
  }
  function writeMemo(run) {
    var s = S.setup, p = S.plan, r = S.res;
    $('memo').className = 'memo wait'; $('memo').textContent = 'Writing the memo from these numbers…'; $('memo-by').textContent = '';
    return post({ mode: 'memo', brief: brief(s, p, r) }, 40000)
      .then(function (j) { if (!j.memo) throw new Error(j.error || 'no memo'); return { text: j.memo, by: 'written by ' + j.model + ' from the numbers above' }; })
      .catch(function () { return { text: localMemo(s, p, r), by: 'the model was unreachable; summary built from the numbers' }; })
      .then(function (m) {
        if (run !== S.run) return;
        r.memo = m.text;
        $('memo').className = 'memo'; $('memo').innerHTML = markdown(m.text); $('memo-by').textContent = m.by;
      });
  }

  /* ---------- running an analysis ---------- */
  function analyse(fromChips) {
    var s = S.setup, run = ++S.run;
    S.plan = resolve(s, S.live);
    S.res = compute(s, S.plan);
    draw(s, S.plan, S.res);
    $('saved-note').textContent = '';
    bookCost(s.ticker, s.side, s.size).then(function (b) {
      if (run !== S.run) return;
      var t = S.res.tests[S.res.tests.length - 1], tone = b.short ? 'bad' : b.slip > 0.0015 ? 'bad' : b.slip > 0.0005 ? 'warn' : 'good';
      t.tone = tone; t.flag = b.short ? 'not enough depth' : b.slip > 0.0005 ? 'above the 0.05% assumed' : 'inside the 0.05% assumed';
      t.value = b.short ? 'Only ' + num(Math.round(b.filled)) + ' USDT on the book' : (b.slip * 100).toFixed(3) + '% to fill';
      t.text = 'Cost of filling ' + num(s.size) + ' USDT against the Bitget book right now, measured from the mid price' + (b.spread != null ? '. The spread is ' + (b.spread * 100).toFixed(3) + '%.' : '.');
      drawTests(S.res.tests);
    }).catch(function () {
      if (run !== S.run) return;
      var t = S.res.tests[S.res.tests.length - 1];
      t.flag = 'unavailable'; t.value = 'Could not read the book'; t.text = 'Bitget’s live order book did not answer. The other tests do not depend on it.';
      drawTests(S.res.tests);
    });
    clearTimeout(S.memoTimer);
    if (fromChips) {
      $('memo').className = 'memo wait'; $('memo').textContent = 'Updating the memo…';
      S.memoTimer = setTimeout(function () { writeMemo(run); }, 1200);
      return Promise.resolve();
    }
    return writeMemo(run);
  }

  /* The first idea is typed in the hero. From then on the form lives in the conversation rail. */
  function openBench(scroll) {
    if ($('ask').parentNode !== $('askrail')) { $('askrail').appendChild($('ask')); $('askhome').hidden = true; }
    $('q').placeholder = 'Ask a follow-up, or try another idea';
    $('bench').hidden = false;
    $('waiting').hidden = !$('file').hidden;
    if (scroll) $('bench').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function say(cls, html) {
    var el = document.createElement('div');
    el.className = 'msg ' + cls; el.innerHTML = html;
    $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight;
    return el;
  }
  function step(list, text) {
    var prev = list.querySelector('.busy');
    if (prev) prev.classList.remove('busy');
    if (!text) return;
    var li = document.createElement('li');
    li.className = 'busy'; li.textContent = text; list.appendChild(li);
    $('log').scrollTop = $('log').scrollHeight;
  }

  function ask(question) {
    question = question.trim();
    if (!question || !D) return;
    $('go').disabled = true; $('q').value = '';
    openBench(true);
    say('you', esc(question));
    var box = say('bot', '<ul></ul>'), list = box.querySelector('ul');
    step(list, 'Reading the idea (Qwen)');
    var wn = windowNow();
    var now = { us_market: wn.active ? 'closed' : 'open', window: wn.w && wn.w.kind, hours_to_open: wn.w ? Math.round((wn.w.open - Date.now()) / H * 10) / 10 : null };
    var results = S.res ? brief(S.setup, S.plan, S.res) : null;
    post({ mode: 'parse', question: question, now: now, setup: S.setup, results: results }, 30000)
      .then(function (j) { if (j.error || !j.kind) throw new Error(j.error); return j; })
      .catch(function () {
        var local = localParse(question, S.setup);
        list.lastChild.classList.add('fail'); list.lastChild.textContent = 'The model was unreachable; read the idea with the built-in parser';
        return local ? { kind: 'setup', setup: local, say: '' } : { kind: 'answer', answer: 'I could not read that. Name one of the ten tokens and a direction, for example “Long NVDA over the weekend”.' };
      })
      .then(function (j) {
        if (j.kind !== 'setup') {
          step(list); list.remove();
          box.insertAdjacentHTML('beforeend', '<p>' + esc(j.answer || '') + '</p>');
          $('waiting').hidden = true;
          return;
        }
        S.setup = normalise(j.setup, S.setup);
        if (j.say) box.insertAdjacentHTML('afterbegin', '<p>' + esc(j.say) + '</p>');
        step(list, 'Pulling live ' + S.setup.ticker + ' and Bitcoin prices from Bitget');
        return liveState(S.setup.ticker).then(function (live) {
          S.live = live;
          if (!live.ok) { list.lastChild.classList.add('fail'); list.lastChild.textContent = 'Bitget live prices did not answer; using the record only'; }
          step(list, 'Searching the record for matching windows');
          var done = analyse(false), r = S.res;
          list.lastChild.textContent = 'Searched ' + r.windows + ' ' + S.plan.kind + ' windows: ' + r.st.n + ' match';
          step(list, 'Ran ' + r.tests.length + ' stress tests');
          step(list, 'Writing the memo (Qwen)');
          return done.then(function () {
            step(list);
            box.insertAdjacentHTML('beforeend', '<p><b>' + esc(r.verdict.tag) + '.</b> ' + esc(r.verdict.head) + ' Change any part of the setup on the right, or ask a follow-up.</p>');
            if (innerWidth < 900) $('file').scrollIntoView({ behavior: 'smooth', block: 'start' });
          });
        });
      })
      .catch(function () {
        step(list);
        box.insertAdjacentHTML('beforeend', '<p>Something went wrong while testing that. Try again.</p>');
        $('waiting').hidden = true;
      })
      .finally(function () { $('go').disabled = false; $('log').scrollTop = $('log').scrollHeight; });
  }
  $('ask').addEventListener('submit', function (ev) { ev.preventDefault(); ask($('q').value); });
  $('q').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ask($('q').value); } });
  hover($('dots')); hover($('paths'));
  var resizing = 0;
  addEventListener('resize', function () {
    clearTimeout(resizing);
    resizing = setTimeout(function () { if (S.res) { drawDots(S.setup, S.res); drawPaths(S.setup, S.res); } }, 150);
  });

  /* ---------- notebook ---------- */
  function notes() { try { return JSON.parse(localStorage.getItem('precedent.notes') || '[]'); } catch (e) { return []; } }
  function keep(list) { try { localStorage.setItem('precedent.notes', JSON.stringify(list)); } catch (e) {} drawNotes(); }
  $('save').addEventListener('click', function () {
    var s = S.setup, p = S.plan, r = S.res, wn = windowNow(), target = null;
    D.upcoming.forEach(function (u) { if (!target && u.kind === p.kind && u.open > Date.now()) target = u.id; });
    var list = notes();
    list.unshift({ at: Date.now(), text: describe(s, p), setup: s, plan: p, target: target, verdict: r.verdict.tag,
      n: r.st.n, median: r.st.n ? r.st.median : null, p5: r.st.n ? r.st.p5 : null, p95: r.st.n ? r.st.p95 : null });
    keep(list.slice(0, 30));
    $('saved-note').textContent = 'Saved. The notebook will show what happened after the window that opens ' + (target ? day(target) : 'next') + '.';
  });
  function drawNotes() {
    var list = notes();
    $('notebook').hidden = !list.length;
    $('notes').innerHTML = list.map(function (n, i) {
      var then = 'Waiting for the window that opens ' + (n.target ? day(n.target) : 'next') + '.';
      var sess = D.sessions.filter(function (x) { return x.id === n.target; })[0], path = sess && D.paths[n.setup.ticker][n.target];
      if (sess && path) {
        var t = trade(n.setup, n.plan, sess, path);
        if (t) then = 'What happened: ' + pct(t.net) + ' (' + usd(t.net * n.setup.size) + ')' + (n.p5 != null && n.n >= 10 ? (t.net < n.p5 || t.net > n.p95 ? ', outside' : ', inside') + ' the range the precedents suggested (' + pct(n.p5) + ' to ' + pct(n.p95) + ').' : '.');
      }
      return '<div class="note"><b>' + esc(n.text) + '</b><p>' + new Date(n.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ' · ' + esc(n.verdict) + ' · ' + n.n + (n.n === 1 ? ' precedent' : ' precedents') + (n.median != null ? ', median ' + pct(n.median) : '') +
        '</p><p class="then">' + esc(then) + '</p><div><button data-run="' + i + '">Re-run</button><button data-del="' + i + '">Delete</button></div></div>';
    }).join('');
  }
  $('notes').addEventListener('click', function (ev) {
    var list = notes(), b = ev.target;
    if (b.dataset.del) { list.splice(Number(b.dataset.del), 1); keep(list); }
    if (b.dataset.run) {
      S.setup = list[Number(b.dataset.run)].setup;
      openBench(true);
      liveState(S.setup.ticker).then(function (l) { S.live = l; analyse(false); });
    }
  });

  /* ---------- start ---------- */
  showRules();
  $('examples').innerHTML = EXAMPLES.map(function (e) { return '<button type="button" data-q="' + esc(e[1]) + '">' + esc(e[0]) + '</button>'; }).join('');
  $('examples').addEventListener('click', function (ev) { if (ev.target.dataset.q) ask(ev.target.dataset.q); });
  fetch('data.json').then(function (r) { return r.json(); }).then(function (data) {
    D = data; U = data.unit; COST = data.cost_per_side;
    var wn = windowNow(), first = D.sessions[0], last = D.sessions[D.sessions.length - 1], left = wn.w ? (wn.active ? wn.w.open : wn.w.close) - Date.now() : 0;
    var clock = left > 0 ? Math.floor(left / H) + 'h ' + Math.floor(left % H / 60000) + 'm' : '';
    $('status').lastChild.textContent = 'US market ' + (wn.active ? 'closed · opens in ' + clock : 'open' + (clock ? ' · closes in ' + clock : ''));
    $('status').dataset.short = (wn.active ? 'Closed · ' : 'Open · ') + clock;
    var paths = D.tickers.reduce(function (n, t) { return n + Object.keys(D.paths[t]).length; }, 0);
    $('p-windows').textContent = D.sessions.length; $('p-paths').textContent = paths;
    $('scene-note').textContent = 'Each line is one real night on Bitget, from the close to the next open. ' + paths + ' of them, ' + day(first.id) + ' to ' + day(last.id) + '.';
    $('sources').textContent = 'The record holds ' + D.sessions.length + ' closed-market windows from ' + day(first.id) + ' to ' + day(last.id) + ' 2026, last rebuilt ' +
      new Date(D.built).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC.';
    window.PRECEDENT = D;
    window.dispatchEvent(new Event('precedent:data'));
    drawNotes();
    var q = new URLSearchParams(location.search).get('q');
    if (q) ask(q);
  }).catch(function () { $('status').lastChild.textContent = 'The record could not be loaded. Reload the page.'; });

  /* ---------- page chrome ---------- */
  function chrome() { $('nav').classList.toggle('solid', scrollY > $('top').offsetHeight - 80); }
  addEventListener('scroll', chrome, { passive: true }); chrome();
  var seen = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); seen.unobserve(e.target); } });
  }, { rootMargin: '0px 0px -8% 0px' }) : null;
  document.querySelectorAll('.reveal').forEach(function (el) {
    var i = Array.prototype.indexOf.call(el.parentNode.children, el);
    el.style.setProperty('--d', el.parentNode.matches('.steps, .checklist') ? i : 0);
    if (seen) seen.observe(el); else el.classList.add('in');
  });
})();
