// Ledgerline · `prices` (Supabase Edge Function, Deno)
// A small Alpha Vantage proxy so your API key stays on the server. Only the three calls the app makes are allowed.
// Secret: ALPHAVANTAGE_KEY. Deploy with "Verify JWT" ON (only your signed-in phone can call it).

const ALLOWED = new Set(["TIME_SERIES_DAILY", "FX_DAILY", "DIVIDENDS"]);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const b = await req.json().catch(() => ({}));
  if (!ALLOWED.has(b.function)) return new Response(JSON.stringify({ error: "Not allowed." }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  const q = new URLSearchParams({ apikey: Deno.env.get("ALPHAVANTAGE_KEY") ?? "" });
  for (const [k, v] of Object.entries(b)) if (k !== "apikey" && typeof v === "string") q.set(k, v);
  const r = await fetch("https://www.alphavantage.co/query?" + q.toString());
  return new Response(await r.text(), { status: r.status, headers: { ...CORS, "Content-Type": "application/json" } });
});
