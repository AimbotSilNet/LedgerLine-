// Ledgerline · `plaid` server function (Supabase Edge Function, Deno)
// Actions: link_token, exchange, describe, link_accounts, relinked, review, sync, disconnect,
//          sync_all (cron) and sync_item (from plaid-webhook).
// Secrets it needs (Supabase → Edge Functions → Secrets): PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, CRON_SECRET.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Deploy with "Verify JWT" turned OFF: this function checks the signed-in user itself, and the cron job
// and the webhook reach it with CRON_SECRET instead.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const env = (k: string) => Deno.env.get(k) ?? "";
const PLAID_ENV = env("PLAID_ENV") || "production";
const PLAID_BASE = PLAID_ENV === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";
const WEBHOOK_URL = `${env("SUPABASE_URL")}/functions/v1/plaid-webhook`;
const admin: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Json = Record<string, any>;
class PlaidError extends Error { code: string; constructor(code: string, msg: string) { super(msg); this.code = code; } }

async function plaid(path: string, body: Json): Promise<Json> {
  const res = await fetch(PLAID_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("PLAID_CLIENT_ID"), secret: env("PLAID_SECRET"), ...body }),
  });
  const out = await res.json();
  if (!res.ok || out.error_code) throw new PlaidError(out.error_code || "PLAID_ERROR", out.display_message || out.error_message || `Plaid ${path} failed`);
  return out;
}

// ---------- helpers ----------
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const daysAgo = (n: number) => { const d = new Date(today() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const r2 = (n: number) => Math.round(n * 100) / 100;
const kindOf = (t: string) => t === "depository" ? "bank" : t === "credit" || t === "loan" ? "card" : t === "investment" ? "invest" : "bank";
const shortId = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").slice(-12);

async function accessToken(itemId: string): Promise<string> {
  const { data, error } = await admin.from("plaid_secrets").select("access_token").eq("item_id", itemId).single();
  if (error || !data) throw new Error("That bank connection wasn't found.");
  return data.access_token;
}
async function ownItem(userId: string, itemId: string) {
  const { data } = await admin.from("plaid_items").select("*").eq("item_id", itemId).eq("user_id", userId).single();
  if (!data) throw new Error("That bank connection isn't yours.");
  return data;
}
async function setStatus(itemId: string, status: string, error: string | null = null) {
  await admin.from("plaid_items").update({ status, error }).eq("item_id", itemId);
}

// Plaid's categories → the app's. Your own merchant rules (Settings › Budgets) win over these.
function mapCategory(t: Json, rules: { k: string; c: string }[], cats: string[]): string {
  const desc = ` ${String(t.merchant_name || t.name || "").toUpperCase()} `;
  const rule = rules.filter(r => r.k && desc.includes(String(r.k).toUpperCase())).sort((a, b) => b.k.length - a.k.length)[0];
  if (rule && cats.includes(rule.c)) return rule.c;
  const p = t.personal_finance_category?.primary || "", d = t.personal_finance_category?.detailed || "";
  const c =
    p === "INCOME" ? "Income" :
    p === "TRANSFER_IN" || p === "TRANSFER_OUT" || p === "LOAN_PAYMENTS" ? "Payment / Transfer" :
    p === "FOOD_AND_DRINK" ? (d.includes("GROCERIES") ? "Groceries" : "Dining") :
    p === "TRANSPORTATION" ? (d.includes("GAS") ? "Gas" : "Transport") :
    p === "TRAVEL" ? "Travel" :
    p === "GENERAL_MERCHANDISE" ? "Shopping" :
    p === "ENTERTAINMENT" ? "Entertainment" :
    p === "RENT_AND_UTILITIES" ? "Bills & Utilities" :
    p === "GENERAL_SERVICES" ? (d.includes("INSURANCE") ? "Bills & Utilities" : "Other") :
    p === "MEDICAL" || p === "PERSONAL_CARE" ? "Health" :
    p === "HOME_IMPROVEMENT" ? "Home" :
    p === "BANK_FEES" ? "Fees & Interest" : "Other";
  return cats.includes(c) ? c : "Other";
}
// Toronto listings are priced as .TRT on Alpha Vantage
function mapTicker(sec: Json): string {
  let t = String(sec?.ticker_symbol || "").trim().toUpperCase();
  if (!t || t.startsWith("CUR:")) return "";
  if (/\.(TO|TSX|CN)$/.test(t)) t = t.replace(/\.(TO|TSX|CN)$/, ".TRT");
  else if ((sec.iso_currency_code === "CAD") && !t.includes(".")) t += ".TRT";
  return t;
}
const mapType = (sec: Json) => sec?.type === "etf" ? "ETF" : sec?.type === "equity" ? "Individual Stock" : sec?.type === "fixed income" ? "Fixed Income" : "Other";

// ---------- sync one bank login ----------
async function syncItem(itemId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: item } = await admin.from("plaid_items").select("*").eq("item_id", itemId).single();
  if (!item) return { ok: false, error: "unknown item" };
  const userId = item.user_id, token = await accessToken(itemId);
  try {
    const { data: rows } = await admin.from("accounts").select("*").eq("user_id", userId);
    const byPlaid = new Map((rows || []).filter(r => r.plaid_account_id).map(r => [r.plaid_account_id, r]));
    const tracked = (pid: string) => { const r = byPlaid.get(pid); return r && !r.hidden && !r.review ? r : null; };

    // 1. balances, and accounts the bank has that you haven't seen yet
    const acc = await plaid("/accounts/get", { access_token: token });
    const day = today();
    for (const a of acc.accounts) {
      const kind = kindOf(a.type);
      if (!byPlaid.has(a.account_id)) {
        const row = { id: "p" + shortId(a.account_id), user_id: userId, type: kind, name: a.official_name || a.name, ccy: a.balances.iso_currency_code || "CAD",
          source: "plaid", plaid_item_id: itemId, plaid_account_id: a.account_id, mask: a.mask, institution: item.institution_name, subtype: a.subtype, review: true, data: {} };
        await admin.from("accounts").insert(row); byPlaid.set(a.account_id, row);
        continue;
      }
      const row = tracked(a.account_id); if (!row || kind === "invest") continue;
      const v = a.balances.current ?? a.balances.available; if (v == null) continue;
      await admin.from("balances").upsert({ user_id: userId, account_id: row.id, date: day, value: r2(v), source: "plaid", updated_at: new Date().toISOString() }, { onConflict: "user_id,account_id,date" });
      if (kind === "card" && a.balances.limit && a.balances.limit !== row.data?.limit)
        await admin.from("accounts").update({ data: { ...row.data, limit: a.balances.limit }, updated_at: new Date().toISOString() }).eq("id", row.id);
    }

    // 2. transactions (cursor-based; pending → posted keeps your category)
    const { data: settingsDoc } = await admin.from("docs").select("data").eq("user_id", userId).eq("path", "config/settings").maybeSingle();
    const rules = settingsDoc?.data?.rules || [];
    const cats: string[] = settingsDoc?.data?.categories || ["Groceries","Dining","Transport","Gas","Shopping","Bills & Utilities","Subscriptions","Travel","Entertainment","Health","Home","Collectibles","Fees & Interest","Income","Other","Payment / Transfer"];
    let cursor = item.cursor || undefined, more = true, guard = 0;
    try {
      while (more && guard++ < 50) {
        const page = await plaid("/transactions/sync", { access_token: token, cursor, count: 500 });
        for (const t of [...page.added, ...page.modified]) await upsertTxn(userId, t, tracked, rules, cats);
        const gone = page.removed.map((x: Json) => x.transaction_id);
        if (gone.length) await admin.from("transactions").delete().eq("user_id", userId).in("plaid_transaction_id", gone);
        cursor = page.next_cursor; more = page.has_more;
      }
      await admin.from("plaid_items").update({ cursor }).eq("item_id", itemId);
    } catch (e) {
      if (!(e instanceof PlaidError) || !["PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_READY", "ADDITIONAL_CONSENT_REQUIRED", "NO_ACCOUNTS", "INVALID_PRODUCT"].includes(e.code)) throw e;
    }

    // 3. investments: holdings, cash and trades
    try { await syncInvestments(userId, itemId, token, tracked, !item.last_synced_at); }
    catch (e) { if (!(e instanceof PlaidError) || !["PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_READY", "ADDITIONAL_CONSENT_REQUIRED", "NO_INVESTMENT_ACCOUNTS", "INVALID_PRODUCT", "NO_ACCOUNTS"].includes(e.code)) throw e; }

    await admin.from("plaid_items").update({ status: "ok", error: null, last_synced_at: new Date().toISOString() }).eq("item_id", itemId);
    return { ok: true };
  } catch (e) {
    const code = (e as PlaidError).code || "";
    if (code === "ITEM_LOGIN_REQUIRED" || code === "PENDING_EXPIRATION") await setStatus(itemId, "login_required", (e as Error).message);
    else await setStatus(itemId, "error", (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

async function upsertTxn(userId: string, t: Json, tracked: (pid: string) => Json | null, rules: any[], cats: string[]) {
  const acct = tracked(t.account_id); if (!acct) return;
  const { data: existing } = await admin.from("transactions").select("id,category,data").eq("plaid_transaction_id", t.transaction_id).maybeSingle();
  let id = existing?.id as string | undefined, keep: Json | null = existing;
  if (!id && t.pending_transaction_id) {                       // the posted row replaces its pending row
    const { data: pend } = await admin.from("transactions").select("id,category,data").eq("plaid_transaction_id", t.pending_transaction_id).maybeSingle();
    if (pend) { id = pend.id; keep = pend; }
  }
  if (!id) {                                                     // a typed or uploaded twin within 4 days is upgraded in place
    const lo = new Date(t.date + "T12:00:00Z"); lo.setUTCDate(lo.getUTCDate() - 4);
    const hi = new Date(t.date + "T12:00:00Z"); hi.setUTCDate(hi.getUTCDate() + 4);
    const { data: twins } = await admin.from("transactions").select("id,category,data").eq("user_id", userId).eq("account_id", acct.id)
      .is("plaid_transaction_id", null).eq("amount", r2(t.amount)).gte("date", lo.toISOString().slice(0, 10)).lte("date", hi.toISOString().slice(0, 10)).limit(1);
    if (twins?.length) { id = twins[0].id; keep = twins[0]; }
  }
  const mine = keep && keep.data?.auto === false;               // you set the category: keep it
  const row = {
    id: id || "pt" + shortId(t.transaction_id), user_id: userId, account_id: acct.id, date: t.date,
    description: t.merchant_name || t.name || "", amount: r2(t.amount),
    category: mine ? keep!.category : mapCategory(t, rules, cats),
    source: "plaid", pending: !!t.pending, plaid_transaction_id: t.transaction_id,
    data: { ...(keep?.data || {}), auto: !mine }, updated_at: new Date().toISOString(),
  };
  await admin.from("transactions").upsert(row, { onConflict: "id" });
}

async function syncInvestments(userId: string, itemId: string, token: string, tracked: (pid: string) => Json | null, first: boolean) {
  const h = await plaid("/investments/holdings/get", { access_token: token });
  const secs = new Map(h.securities.map((s: Json) => [s.security_id, s]));
  const cash: Record<string, { CAD: number; USD: number }> = {}, seen = new Set<string>();
  const { data: existing } = await admin.from("holdings").select("id,data").eq("user_id", userId);
  const prev = new Map((existing || []).map(r => [r.id, r.data]));
  for (const x of h.holdings) {
    const acct = tracked(x.account_id); if (!acct) continue;
    const s: Json = secs.get(x.security_id) || {}; const ccy = x.iso_currency_code || s.iso_currency_code || "CAD";
    if (s.type === "cash" || s.is_cash_equivalent && String(s.ticker_symbol || "").startsWith("CUR:")) {
      const c = cash[acct.id] = cash[acct.id] || { CAD: 0, USD: 0 }; c[ccy === "USD" ? "USD" : "CAD"] += x.institution_value || 0; continue;
    }
    const id = `ph_${acct.id}_${shortId(x.security_id)}`, old: Json = prev.get(id) || {}; seen.add(id);
    const ticker = old.tickerOverride ?? mapTicker(s);
    const data = { ...old, id, account: acct.id, name: old.name || s.name || ticker || "Holding", ticker, ccy, type: old.type || mapType(s),
      shares: x.quantity, avgCost: x.cost_basis != null && x.quantity ? r2(x.cost_basis / x.quantity * 1e4) / 1e4 : x.institution_price,
      lastPrice: x.institution_price, source: "plaid", wht: old.wht ?? (ccy === "USD" ? 0.15 : 0), region: old.region || "" };
    await admin.from("holdings").upsert({ id, user_id: userId, account_id: acct.id, data, updated_at: new Date().toISOString() }, { onConflict: "id" });
  }
  // positions the brokerage no longer reports were sold out of
  const accts = [...new Set(h.accounts.map((a: Json) => tracked(a.account_id)?.id).filter(Boolean))] as string[];
  for (const aid of accts) {
    const stale = (existing || []).filter(r => r.id.startsWith(`ph_${aid}_`) && !seen.has(r.id)).map(r => r.id);
    if (stale.length) await admin.from("holdings").delete().in("id", stale);
    const { data: row } = await admin.from("accounts").select("data").eq("id", aid).single();
    await admin.from("accounts").update({ data: { ...(row?.data || {}), cash: cash[aid] || { CAD: 0, USD: 0 } }, updated_at: new Date().toISOString() }).eq("id", aid);
  }
  // buys and sells
  let offset = 0, total = 1;
  while (offset < total && offset < 5000) {
    const t = await plaid("/investments/transactions/get", { access_token: token, start_date: daysAgo(first ? 730 : 45), end_date: today(), options: { count: 500, offset } });
    total = t.total_investment_transactions; offset += t.investment_transactions.length; if (!t.investment_transactions.length) break;
    const tsecs = new Map(t.securities.map((s: Json) => [s.security_id, s]));
    for (const x of t.investment_transactions) {
      if (x.type !== "buy" && x.type !== "sell") continue;
      const acct = tracked(x.account_id); if (!acct) continue;
      const s: Json = tsecs.get(x.security_id) || {};
      const id = "pt_" + shortId(x.investment_transaction_id);
      const data = { id, at: Date.parse(x.date + "T12:00:00Z"), date: x.date, account: acct.id, hid: `ph_${acct.id}_${shortId(x.security_id || "")}`,
        name: s.name || x.name, ticker: mapTicker(s), ccy: x.iso_currency_code || "CAD", side: x.type, qty: Math.abs(x.quantity), price: x.price,
        comm: x.fees || 0, cash: true, cashAmt: r2(-x.amount), source: "plaid" };
      await admin.from("trades").upsert({ id, user_id: userId, account_id: acct.id, date: x.date, data, updated_at: new Date().toISOString() }, { onConflict: "id" });
    }
  }
}

// ---------- actions ----------
async function handle(action: string, b: Json, userId: string) {
  switch (action) {
    case "link_token": {
      const base: Json = { user: { client_user_id: userId }, client_name: "Ledgerline", country_codes: ["CA", "US"], language: "en", webhook: WEBHOOK_URL };
      if (b.item_id) {                                           // update mode: sign in again, or share new accounts
        await ownItem(userId, b.item_id);
        const r = await plaid("/link/token/create", { ...base, access_token: await accessToken(b.item_id), update: { account_selection_enabled: !!b.new_accounts } });
        return { link_token: r.link_token };
      }
      const products = b.kind === "invest" ? ["investments"] : ["transactions"];
      const r = await plaid("/link/token/create", { ...base, products, transactions: { days_requested: 730 } });
      return { link_token: r.link_token };
    }
    case "exchange": {
      const r = await plaid("/item/public_token/exchange", { public_token: b.public_token });
      await admin.from("plaid_items").upsert({ item_id: r.item_id, user_id: userId, institution_name: b.institution?.name || "Bank", institution_id: b.institution?.institution_id || null, status: "ok" });
      await admin.from("plaid_secrets").upsert({ item_id: r.item_id, user_id: userId, access_token: r.access_token });
      return { item_id: r.item_id };
    }
    case "describe": {
      const item = await ownItem(userId, b.item_id);
      const acc = await plaid("/accounts/get", { access_token: await accessToken(b.item_id) });
      const { data: rows } = await admin.from("accounts").select("*").eq("user_id", userId);
      const all = rows || [], manual = all.filter(r => r.source !== "plaid" && !r.hidden && !r.review);
      return {
        item_id: b.item_id, institution: item.institution_name,
        accounts: acc.accounts.map((a: Json) => {
          const kind = kindOf(a.type), known = all.find(r => r.plaid_account_id === a.account_id);
          const twin = !known && manual.find(m => m.type === kind && a.mask && m.name.includes(a.mask));
          return { plaid_account_id: a.account_id, name: a.official_name || a.name, mask: a.mask, kind, balance: a.balances.current ?? a.balances.available, ccy: a.balances.iso_currency_code || "CAD",
            suggest: known ? (known.hidden ? { action: "skip" } : known.review ? { action: "new" } : { action: "keep", account_id: known.id }) : twin ? { action: "link", account_id: twin.id } : { action: "new" } };
        }),
        manual: manual.map(m => ({ id: m.id, name: m.name, type: m.type })),
      };
    }
    case "link_accounts": {
      const item = await ownItem(userId, b.item_id);
      const acc = await plaid("/accounts/get", { access_token: await accessToken(b.item_id) });
      const meta = new Map<string, Json>(acc.accounts.map((a: Json) => [a.account_id, a]));
      for (const c of (b.choices || []) as Json[]) {
        const a = meta.get(c.plaid_account_id); if (!a) continue;
        const cols = { source: "plaid", plaid_item_id: b.item_id, plaid_account_id: a.account_id, mask: a.mask, institution: item.institution_name, subtype: a.subtype, updated_at: new Date().toISOString() };
        const { data: known } = await admin.from("accounts").select("id").eq("plaid_account_id", a.account_id).maybeSingle();
        if (c.action === "link" && c.account_id) {
          if (known && known.id !== c.account_id) await admin.from("accounts").delete().eq("id", known.id);
          await admin.from("accounts").update({ ...cols, hidden: false, review: false }).eq("id", c.account_id).eq("user_id", userId);
        } else if (c.action === "skip") {
          if (known) await admin.from("accounts").update({ hidden: true, review: false }).eq("id", known.id);
          else await admin.from("accounts").insert({ id: "p" + shortId(a.account_id), user_id: userId, type: kindOf(a.type), name: a.official_name || a.name, ccy: a.balances.iso_currency_code || "CAD", ...cols, hidden: true });
        } else {
          const kind = kindOf(a.type);
          const data: Json = kind === "card" && a.balances.limit ? { limit: a.balances.limit } : kind === "invest" ? { cash: { CAD: 0, USD: 0 } } : {};
          if (known) await admin.from("accounts").update({ ...cols, hidden: false, review: false }).eq("id", known.id);
          else await admin.from("accounts").insert({ id: "p" + shortId(a.account_id), user_id: userId, type: kind, name: a.official_name || a.name, ccy: a.balances.iso_currency_code || "CAD", ...cols, data });
        }
      }
      return { sync: await syncItem(b.item_id) };
    }
    case "relinked": { await ownItem(userId, b.item_id); await setStatus(b.item_id, "ok"); return { sync: await syncItem(b.item_id) }; }
    case "review": {
      const patch = b.add ? { review: false, hidden: false } : { review: false, hidden: true };
      await admin.from("accounts").update(patch).eq("id", b.account_id).eq("user_id", userId);
      const { data: row } = await admin.from("accounts").select("plaid_item_id").eq("id", b.account_id).single();
      if (b.add && row?.plaid_item_id) await syncItem(row.plaid_item_id);
      return { ok: true };
    }
    case "sync": {
      const { data: items } = await admin.from("plaid_items").select("item_id").eq("user_id", userId);
      const results = []; for (const i of items || []) results.push(await syncItem(i.item_id));
      return { ok: results.every(r => r.ok), results };
    }
    case "disconnect": {
      await ownItem(userId, b.item_id);
      try { await plaid("/item/remove", { access_token: await accessToken(b.item_id) }); } catch (_) { /* already gone at Plaid */ }
      // accounts stay as manual with their history; plaid ids are cleared so a reconnect matches instead of duplicating
      await admin.from("accounts").update({ source: "manual", plaid_item_id: null, plaid_account_id: null }).eq("plaid_item_id", b.item_id).eq("user_id", userId);
      await admin.from("plaid_items").delete().eq("item_id", b.item_id);
      return { ok: true };
    }
    default: throw new Error("Unknown action.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    // server-to-server: the scheduled sync and the webhook
    if (action === "sync_all" || action === "sync_item" || action === "set_status") {
      if (!env("CRON_SECRET") || req.headers.get("x-cron-secret") !== env("CRON_SECRET")) return json({ error: "Not allowed." }, 401);
      if (action === "set_status") { await setStatus(body.item_id, body.status); return json({ ok: true }); }
      if (action === "sync_item") return json(await syncItem(body.item_id));
      const { data: items } = await admin.from("plaid_items").select("item_id").neq("status", "login_required");
      const results = []; for (const i of items || []) results.push(await syncItem(i.item_id));
      return json({ ok: true, synced: results.length });
    }
    // everything else: the signed-in phone
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u, error } = await admin.auth.getUser(jwt);
    if (error || !u?.user) return json({ error: "Sign in again." }, 401);
    return json(await handle(action, body, u.user.id));
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message || "Something went wrong." }, 400);
  }
});
