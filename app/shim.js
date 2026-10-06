/* Ledgerline · phone shim
 * The app file is the same one that runs as a Claude page. There it asks Claude for storage
 * (window.claude.use("db")); here this shim answers instead, backed by your own Supabase project:
 *   - signs you in (email + password),
 *   - maps the app's documents onto the tables in DATA.md and keeps them live,
 *   - exposes window.ledgerline.plaid for bank connections (Plaid Link + the `plaid` server function),
 *   - routes live prices through the `prices` server function.
 *   - routes the app's Claude requests (Analysis, Ask, reading PDFs, sort with AI) through the `ai` server function.
 * Set `claude: false` in config.js to turn the Claude features off. */
(() => {
  "use strict";
  const CFG = window.LEDGERLINE_CONFIG || {};
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || /YOUR-/.test(CFG.supabaseUrl + CFG.supabaseAnonKey)) {
    document.addEventListener("DOMContentLoaded", () => { document.body.insertAdjacentHTML("afterbegin", `<div style="padding:60px 24px;font:16px -apple-system,sans-serif;color:#E3ECEA;background:#0E1A1C;min-height:100vh">Ledgerline isn't set up yet: put your Supabase Project URL and anon key in <b>config.js</b>, then upload the folder again.</div>`); });
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "ledgerline-auth" } });
  let user = null;

  // ---------- sign in ----------
  const domReady = new Promise(r => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", r, { once: true }) : r());
  function loginScreen() {
    return new Promise(resolve => domReady.then(() => {
      const el = document.createElement("div"); el.id = "ll-login";
      el.innerHTML = `<style>
        #ll-login{position:fixed;inset:0;z-index:100;background:var(--paper,#0E1A1C);color:var(--ink,#E3ECEA);display:flex;align-items:center;justify-content:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom,0px));font:15px/1.45 -apple-system,"SF Pro Text",system-ui,sans-serif}
        #ll-login form{width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px}
        #ll-login h1{font:700 34px/1.1 -apple-system,"SF Pro Display",system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 4px}
        #ll-login p{margin:0;color:var(--muted,#7F9694);font-size:13px}
        #ll-login label{display:flex;flex-direction:column;gap:4px;font:600 10.5px/1.2 -apple-system,system-ui,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:var(--muted,#7F9694)}
        #ll-login input{font:16px -apple-system,system-ui,sans-serif;color:inherit;background:var(--panel-2,#1B2E31);border:.5px solid var(--line-2,#2F4649);border-radius:10px;padding:10px 12px;min-height:44px;letter-spacing:0;text-transform:none}
        #ll-login input:focus{outline:none;border-color:var(--accent,#F0663F)}
        #ll-login button{min-height:44px;border:0;border-radius:10px;background:var(--accent,#F0663F);color:var(--accent-ink,#200B05);font:600 15px -apple-system,system-ui,sans-serif;margin-top:4px}
        #ll-login button:disabled{opacity:.5}
        #ll-login .err{color:var(--down,#E07592);min-height:1.4em}
      </style>
      <form novalidate>
        <h1>Ledgerline</h1><p>Sign in with the account you made in Supabase.</p>
        <label>Email<input type="email" name="email" autocomplete="username" required></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit">Sign in</button><p class="err" role="alert" aria-live="assertive"></p>
      </form>`;
      document.body.appendChild(el);
      const f = el.querySelector("form"), btn = f.querySelector("button"), err = f.querySelector(".err");
      f.addEventListener("submit", async e => {
        e.preventDefault(); err.textContent = ""; btn.disabled = true; btn.textContent = "Signing in…";
        const { data, error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
        btn.disabled = false; btn.textContent = "Sign in";
        if (error) { err.textContent = /invalid login/i.test(error.message) ? "That email and password don't match." : error.message; return; }
        user = data.user; el.remove(); resolve();
      });
      setTimeout(() => f.email.focus(), 50);
    }));
  }
  const signedIn = (async () => {
    const { data } = await sb.auth.getSession();
    if (data.session) { user = data.session.user; return; }
    await loginScreen();
  })();

  // ---------- local copy of your tables ----------
  const TABLES = ["accounts", "balances", "transactions", "holdings", "trades", "docs", "plaid_items"];
  const KEY = { accounts: r => r.id, balances: r => r.account_id + "|" + r.date, transactions: r => r.id, holdings: r => r.id, trades: r => r.id, docs: r => r.path, plaid_items: r => r.item_id };
  const C = Object.fromEntries(TABLES.map(t => [t, new Map()]));
  const recent = new Map();                                   // rows this phone just wrote: ignore their echo for a moment
  const mark = (t, k) => recent.set(t + ":" + k, Date.now());
  const now = () => new Date().toISOString();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const fail = e => { throw { message: e?.message || "Couldn't save. Check your connection and try again.", code: e?.code }; };

  async function fetchAll(t) {
    const out = [];
    for (let i = 0; ; i += 1000) {
      const { data, error } = await sb.from(t).select("*").range(i, i + 999);
      if (error) throw error;
      out.push(...data); if (data.length < 1000) break;
    }
    return out;
  }
  async function loadAll() {
    const res = await Promise.all(TABLES.map(fetchAll));
    TABLES.forEach((t, i) => { C[t].clear(); res[i].forEach(r => C[t].set(KEY[t](r), r)); });
  }
  const loaded = signedIn.then(loadAll);

  // ---------- documents the app reads ----------
  function acctToApp(r) {
    return { ...(r.data || {}), id: r.id, name: r.name, type: r.type, ccy: r.ccy || "CAD", source: r.source,
      ...(r.plaid_item_id ? { plaidItem: r.plaid_item_id } : {}), ...(r.institution ? { institution: r.institution } : {}), ...(r.mask ? { mask: r.mask } : {}) };
  }
  function buildSettings() {
    const base = C.docs.get("config/settings")?.data || {};
    const rows = [...C.accounts.values()];
    const vis = rows.filter(r => !r.hidden && !r.review).sort((a, b) => (a.data?.sort ?? 1e9) - (b.data?.sort ?? 1e9) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
    return { ...base, accounts: vis.map(acctToApp),
      connections: [...C.plaid_items.values()].map(i => ({ item_id: i.item_id, institution_name: i.institution_name, status: i.status, last_synced_at: i.last_synced_at })),
      reviewAccounts: rows.filter(r => r.review && !r.hidden).map(r => ({ id: r.id, name: r.name, institution: r.institution, mask: r.mask })) };
  }
  function buildLog() {
    const by = new Map();
    for (const r of C.balances.values()) {
      let e = by.get(r.date); if (!e) by.set(r.date, e = { id: "d" + r.date, date: r.date, values: {} });
      e.values[r.account_id] = Number(r.value); if (r.note && !e.note) e.note = r.note;
    }
    return { entries: [...by.values()].sort((a, b) => a.date.localeCompare(b.date)) };
  }
  const txToApp = r => ({ ...(r.data || {}), id: r.id, date: r.date, desc: r.description, amount: Number(r.amount), category: r.category, account: r.account_id, source: r.source, ...(r.pending ? { pending: true } : {}) });
  const monthTx = m => [...C.transactions.values()].filter(r => r.date.slice(0, 7) === m).map(txToApp);
  function docData(path) {
    if (path === "config/settings") return C.docs.has(path) || C.accounts.size ? buildSettings() : undefined;
    if (path === "balances/log") return buildLog();
    if (path === "holdings/list") return { items: [...C.holdings.values()].map(r => ({ ...r.data, id: r.id, account: r.account_id })) };
    if (path === "trades/log") return { items: [...C.trades.values()].map(r => ({ ...r.data, id: r.id, account: r.account_id, date: r.date })) };
    if (path.startsWith("ledger/")) return { txns: monthTx(path.slice(7)) };
    return C.docs.get(path)?.data;
  }
  const pathsFor = (t, row) => t === "accounts" || t === "plaid_items" ? ["config/settings"] : t === "balances" ? ["balances/log"] : t === "holdings" ? ["holdings/list"]
    : t === "trades" ? ["trades/log"] : t === "transactions" ? ["@ledger"] : [row?.path];

  // ---------- live updates ----------
  const docL = new Map(), colL = new Set(); let pend = new Set(), timer = 0;
  function notify(paths) {
    paths.forEach(p => p && pend.add(p)); clearTimeout(timer);
    timer = setTimeout(() => {
      const ps = pend; pend = new Set();
      for (const p of ps) {
        if (p === "@ledger") { colL.forEach(cb => cb(ledgerSnap())); continue; }
        (docL.get(p) || []).forEach(cb => cb(docSnap(p)));
      }
    }, 120);
  }
  const notifyAll = () => notify([...docL.keys(), "@ledger"]);
  const docSnap = p => { const d = docData(p); return { exists: d !== undefined, data: () => d }; };
  function ledgerSnap() {
    const months = [...new Set([...C.transactions.values()].map(r => r.date.slice(0, 7)))];
    return { docs: months.map(m => ({ id: m, exists: true, data: () => ({ txns: monthTx(m) }) })) };
  }
  signedIn.then(() => {
    let ch = sb.channel("ledgerline");
    for (const t of TABLES) ch = ch.on("postgres_changes", { event: "*", schema: "public", table: t, filter: `user_id=eq.${user.id}` }, p => {
      const row = p.eventType === "DELETE" ? p.old : p.new, k = KEY[t](row);
      if (Date.now() - (recent.get(t + ":" + k) || 0) < 4000) return;
      const prev = C[t].get(k);
      if (p.eventType === "DELETE") C[t].delete(k); else C[t].set(k, row);
      notify(t === "transactions" || !prev ? pathsFor(t, row) : [...pathsFor(t, row), ...pathsFor(t, prev)]);
    });
    ch.subscribe();
  });
  // iOS pauses the page in the background: catch up when it comes back
  document.addEventListener("visibilitychange", () => { if (!document.hidden && user) loadAll().then(notifyAll).catch(() => {}); });

  // ---------- writes ----------
  async function upsertRows(t, rows, onConflict) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(t).upsert(rows.slice(i, i + 500), onConflict ? { onConflict } : undefined);
      if (error) fail(error);
    }
  }
  async function writeSettings(d) {
    const { accounts = [], connections, reviewAccounts, ...rest } = d || {};
    await writeDoc("config/settings", rest);
    const seen = new Set(), ins = [];
    for (const [i, a] of accounts.entries()) {
      seen.add(a.id);
      const { id, name, type, ccy, source, plaidItem, institution, mask, ...data } = a; data.sort = i;
      const cur = C.accounts.get(id);
      if (cur) {
        const patch = { name, type, ccy: ccy || "CAD", data, hidden: false };
        if (same({ name: cur.name, type: cur.type, ccy: cur.ccy, data: cur.data, hidden: cur.hidden }, patch)) continue;
        mark("accounts", id); C.accounts.set(id, { ...cur, ...patch });
        const { error } = await sb.from("accounts").update({ ...patch, updated_at: now() }).eq("id", id); if (error) fail(error);
      } else {
        const row = { id, user_id: user.id, name, type, ccy: ccy || "CAD", source: "manual", data, created_at: now() };
        mark("accounts", id); C.accounts.set(id, row); ins.push(row);
      }
    }
    if (ins.length) await upsertRows("accounts", ins, "id");
    for (const r of [...C.accounts.values()]) if (!r.hidden && !r.review && !seen.has(r.id)) {     // deleted in the app: hidden, history kept
      mark("accounts", r.id); C.accounts.set(r.id, { ...r, hidden: true });
      const { error } = await sb.from("accounts").update({ hidden: true, updated_at: now() }).eq("id", r.id); if (error) fail(error);
    }
  }
  async function writeLog(d) {
    const want = new Map();
    for (const e of d?.entries || []) for (const [id, v] of Object.entries(e.values || {})) if (v !== null && v !== "" && !isNaN(v)) want.set(id + "|" + e.date, { account_id: id, date: e.date, value: +v, note: e.note || null });
    const up = [];
    for (const [k, w] of want) {
      const cur = C.balances.get(k); if (cur && Number(cur.value) === w.value) continue;
      const row = { ...w, user_id: user.id, source: w.note === "from statement" ? "statement" : "manual", updated_at: now() };
      mark("balances", k); C.balances.set(k, row); up.push(row);
    }
    await upsertRows("balances", up, "user_id,account_id,date");
    for (const [k, r] of [...C.balances]) if (!want.has(k) && r.source !== "plaid") {
      mark("balances", k); C.balances.delete(k);
      const { error } = await sb.from("balances").delete().eq("account_id", r.account_id).eq("date", r.date); if (error) fail(error);
    }
  }
  async function writeList(t, items, toRow) {
    const want = new Map(items.map(x => [x.id, x])), up = [];
    for (const [id, x] of want) {
      const cur = C[t].get(id), row = toRow(x, cur);
      if (cur && same({ account_id: cur.account_id, data: cur.data, date: cur.date }, { account_id: row.account_id, data: row.data, date: row.date })) continue;
      mark(t, id); C[t].set(id, { ...cur, ...row }); up.push(row);
    }
    await upsertRows(t, up, "id");
    const gone = [...C[t].values()].filter(r => !want.has(r.id) && r.data?.source !== "plaid").map(r => r.id);
    if (gone.length) { gone.forEach(id => { mark(t, id); C[t].delete(id); }); const { error } = await sb.from(t).delete().in("id", gone); if (error) fail(error); }
  }
  const writeHoldings = d => writeList("holdings", d?.items || [], (x, cur) => {
    const { id, account, ...rest } = x, data = { ...rest };
    if (cur?.data?.source === "plaid" && cur.data.ticker !== x.ticker) data.tickerOverride = x.ticker;   // your ticker survives the next sync
    return { id, user_id: user.id, account_id: account, data: { ...data, account }, updated_at: now() };
  });
  const writeTrades = d => writeList("trades", d?.items || [], x => { const { id, account, date, ...rest } = x; return { id, user_id: user.id, account_id: account || "", date, data: { ...rest, account, date }, updated_at: now() }; });
  async function writeMonth(m, d) {
    const txns = d?.txns || [], want = new Map(txns.map(t => [t.id, t])), up = [];
    for (const t of txns) {
      const { id, date, desc, amount, category, account, source, pending, ...data } = t;
      const row = { id, user_id: user.id, date, description: desc || "", amount: Math.round(+amount * 100) / 100, category: category || "Other", account_id: account || "", source: source || "manual", pending: !!pending, data, updated_at: now() };
      const cur = C.transactions.get(id);
      if (cur && same(txToApp(cur), txToApp(row))) continue;
      mark("transactions", id); C.transactions.set(id, { ...cur, ...row }); up.push(row);
    }
    await upsertRows("transactions", up, "id");
    const gone = [...C.transactions.values()].filter(r => r.date.slice(0, 7) === m && !want.has(r.id)).map(r => r.id);
    if (gone.length) { gone.forEach(id => { mark("transactions", id); C.transactions.delete(id); }); const { error } = await sb.from("transactions").delete().in("id", gone); if (error) fail(error); }
  }
  async function writeDoc(path, data) {
    mark("docs", path); C.docs.set(path, { user_id: user.id, path, data, updated_at: now() });
    const { error } = await sb.from("docs").upsert({ user_id: user.id, path, data, updated_at: now() }, { onConflict: "user_id,path" }); if (error) fail(error);
  }
  let queue = Promise.resolve();
  function write(path, data) {
    const run = () => (path === "config/settings" ? writeSettings(data) : path === "balances/log" ? writeLog(data) : path === "holdings/list" ? writeHoldings(data)
      : path === "trades/log" ? writeTrades(data) : path.startsWith("ledger/") ? writeMonth(path.slice(7), data) : writeDoc(path, data))
      .then(() => notify(path.startsWith("ledger/") ? ["@ledger"] : [path]));
    const p = queue.then(run, run); queue = p.catch(() => {}); return p;
  }

  const db = {
    doc: path => ({
      onSnapshot(cb, onErr) { (docL.get(path) || docL.set(path, new Set()).get(path)).add(cb); loaded.then(() => cb(docSnap(path)), e => onErr?.(e)); return () => docL.get(path)?.delete(cb); },
      set: data => write(path, JSON.parse(JSON.stringify(data))),
    }),
    collection: name => ({
      onSnapshot(cb, onErr) { if (name !== "ledger") return () => {}; colL.add(cb); loaded.then(() => cb(ledgerSnap()), e => onErr?.(e)); return () => colL.delete(cb); },
    }),
  };

  // ---------- prices (Alpha Vantage through the `prices` function) ----------
  const mcp = {
    async callTool(_server, tool, args) {
      const { data, error } = await sb.functions.invoke("prices", { body: { function: tool, ...args } });
      if (error) throw { code: "server_unavailable", message: "Prices didn't load. Try again in a minute." };
      const note = data?.Information || data?.Note;
      if (note && !data["Time Series (Daily)"] && !data["Time Series FX (Daily)"] && !data.data)
        throw { code: "rate_limited", message: /limit|frequency|premium/i.test(note) ? "Alpha Vantage's free daily limit is used up. Prices refresh tomorrow." : note };
      return { payload: data };
    },
  };
  // ---------- Claude (the `ai` function, which holds your Anthropic API key) ----------
  async function aiFetch(body) {
    const { data } = await sb.auth.getSession();
    const r = await fetch(`${CFG.supabaseUrl}/functions/v1/ai`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token || ""}`, apikey: CFG.supabaseAnonKey }, body: JSON.stringify(body) });
    if (!r.ok) {
      let e = {}; try { e = await r.json(); } catch (_) {}
      throw { code: r.status === 429 ? "rate_limited" : r.status === 401 || r.status === 403 ? "not_granted" : e.type || "ai_error",
        message: r.status === 404 ? "Claude isn't set up yet: deploy the ai function (SETUP.md, step 3)." : e.error || e.msg || "Claude didn't answer. Try again." };
    }
    return r;
  }
  const toMessages = p => typeof p === "string" ? [{ role: "user", content: p }] : (p || []).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") }));
  // streamed answer: the app shows the words as they arrive through opts.onText({text})
  async function sample(prompt, opts = {}) {
    const r = await aiFetch({ messages: toMessages(prompt), tier: opts.modelTier, stream: true });
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = "", text = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; opts.onText?.({ text }); }
          else if (ev.type === "error") throw { code: ev.error?.type === "overloaded_error" ? "rate_limited" : "ai_error", message: ev.error?.message || "Claude stopped partway. Try again." };
        }
      }
    }
    return { text };
  }
  // structured answer: the app asks for JSON (reading statements, sorting categories, voice entry)
  sample.json = async (prompt, opts = {}) => {
    const r = await aiFetch({ messages: toMessages(prompt), tier: opts.modelTier, json: true });
    const out = await r.json(), txt = (out.content || []).map(c => c.text || "").join("").trim();
    const body = txt.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(body); } catch (_) {}
    const a = body.indexOf("{"), z = body.lastIndexOf("}");
    if (a >= 0 && z > a) { try { return JSON.parse(body.slice(a, z + 1)); } catch (_) {} }
    throw { code: "ai_error", message: "Claude's answer couldn't be read. Try again." };
  };
  sample.limits = async () => ({ maxPromptBytes: 180000 });
  const claudeOn = CFG.claude !== false;
  const permissions = { state: async n => String(n).startsWith("mcp:") || (n === "sample" && claudeOn) ? "granted" : "denied" };
  const downloads = {
    async save({ filename, data }) {
      const file = new File([data], filename, { type: "application/json" });
      if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file] }); return; } catch (e) { if (e?.name === "AbortError") throw { code: "cancelled" }; } }
      const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = filename; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    },
  };

  window.claude = {
    async use(name) {
      await signedIn;
      if (name === "db") { await loaded; return db; }
      if (name === "mcp") return mcp;
      if (name === "permissions") return permissions;
      if (name === "downloads") return downloads;
      if (name === "sample" && claudeOn) return sample;
      throw new Error(name + " isn't available here");
    },
  };

  // ---------- bank connections ----------
  async function call(action, body = {}) {
    const { data, error } = await sb.functions.invoke("plaid", { body: { action, ...body } });
    if (error) { let msg = error.message; try { msg = (await error.context.json()).error || msg; } catch (_) {} throw new Error(msg); }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  function openLink(token) {
    return new Promise((resolve, reject) => {
      if (!window.Plaid) return reject(new Error("Plaid didn't load. Check your connection."));
      const h = window.Plaid.create({ token,
        onSuccess: (public_token, meta) => resolve({ public_token, meta }),
        onExit: err => err ? reject(new Error(err.display_message || err.error_message || "The bank sign-in stopped.")) : resolve(null) });
      h.open();
    });
  }
  const refresh = () => loadAll().then(notifyAll);
  let lastSync = 0;
  window.ledgerline = {
    email: () => user?.email || "",
    signOut: async () => { await sb.auth.signOut(); location.reload(); },
    plaid: {
      async connect({ kind }) {
        const { link_token } = await call("link_token", { kind });
        const r = await openLink(link_token); if (!r) return null;
        const { item_id } = await call("exchange", { public_token: r.public_token, institution: r.meta?.institution });
        return call("describe", { item_id, kind });
      },
      async reconnect(itemId, { newAccounts } = {}) {
        const { link_token } = await call("link_token", { item_id: itemId, new_accounts: !!newAccounts });
        const r = await openLink(link_token); if (!r) return null;
        if (newAccounts) return call("describe", { item_id: itemId });
        await call("relinked", { item_id: itemId }); await refresh(); return { ok: true };
      },
      async linkAccounts(itemId, choices) { const out = await call("link_accounts", { item_id: itemId, choices }); await refresh(); return out; },
      async review(id, add) { await call("review", { account_id: id, add }); await refresh(); },
      async disconnect(itemId) { await call("disconnect", { item_id: itemId }); await refresh(); },
      async sync() {
        await loaded; if (!C.plaid_items.size || Date.now() - lastSync < 120000) return { ok: true };
        lastSync = Date.now(); const out = await call("sync"); await refresh(); return out;
      },
      resume: async () => null,      // Canadian banks don't use OAuth redirects, so there is nothing to resume
    },
  };
})();
