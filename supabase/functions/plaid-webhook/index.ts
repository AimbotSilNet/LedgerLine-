// Ledgerline · `plaid-webhook` (Supabase Edge Function, Deno)
// Plaid calls this when a bank has new activity. It checks Plaid's signature, then asks the `plaid`
// function to sync that bank login. Deploy with "Verify JWT" turned OFF (Plaid can't send a Supabase token).
// Secrets: PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV, CRON_SECRET (the same values the `plaid` function uses).

import { decodeProtectedHeader, importJWK, jwtVerify } from "npm:jose@5";

const env = (k: string) => Deno.env.get(k) ?? "";
const PLAID_BASE = env("PLAID_ENV") === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";
const keys = new Map<string, CryptoKey | Uint8Array>();

async function verify(req: Request, body: string): Promise<boolean> {
  const token = req.headers.get("plaid-verification"); if (!token) return false;
  const { kid, alg } = decodeProtectedHeader(token); if (alg !== "ES256" || !kid) return false;
  if (!keys.has(kid)) {
    const r = await fetch(PLAID_BASE + "/webhook_verification_key/get", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env("PLAID_CLIENT_ID"), secret: env("PLAID_SECRET"), key_id: kid }) });
    const out = await r.json(); if (!r.ok || !out.key) return false;
    keys.set(kid, await importJWK(out.key, "ES256"));
  }
  const { payload } = await jwtVerify(token, keys.get(kid)!, { maxTokenAge: "5 min" });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
  const hex = [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
  return payload.request_body_sha256 === hex;
}

const callPlaidFn = (body: Record<string, unknown>) => fetch(`${env("SUPABASE_URL")}/functions/v1/plaid`, {
  method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": env("CRON_SECRET") }, body: JSON.stringify(body) });

Deno.serve(async (req) => {
  const body = await req.text();
  try { if (!(await verify(req, body))) return new Response("bad signature", { status: 401 }); }
  catch (_) { return new Response("bad signature", { status: 401 }); }
  const w = JSON.parse(body), item = w.item_id;
  const type = w.webhook_type, code = w.webhook_code;
  if (type === "ITEM") {
    const status = code === "ERROR" && w.error?.error_code === "ITEM_LOGIN_REQUIRED" ? "login_required"
      : code === "ERROR" ? "error"
      : code === "PENDING_EXPIRATION" || code === "PENDING_DISCONNECT" ? "pending_expiration"
      : code === "NEW_ACCOUNTS_AVAILABLE" ? "new_accounts"
      : code === "LOGIN_REPAIRED" ? "ok" : null;
    if (status) await callPlaidFn({ action: "set_status", item_id: item, status });
  } else if (["TRANSACTIONS", "HOLDINGS", "INVESTMENTS_TRANSACTIONS"].includes(type)) {
    // answer Plaid quickly; the sync carries on in the background
    // @ts-ignore EdgeRuntime is provided by Supabase
    const job = callPlaidFn({ action: "sync_item", item_id: item }); if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job); else await job;
  }
  return new Response("ok");
});
