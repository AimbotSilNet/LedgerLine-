// Ledgerline · `ai` (Supabase Edge Function, Deno)
// Lets the phone app use Claude for the written Analysis, Ask, reading PDF statements and "sort with AI".
// It forwards the app's request to Anthropic's Messages API with your key, which never leaves the server.
// Secret: ANTHROPIC_API_KEY (console.anthropic.com → API Keys).
// Optional secrets: AI_MODEL (default claude-sonnet-5-5) and AI_MODEL_QUICK (default claude-haiku-4-5-20251001).
// Deploy with "Verify JWT" ON, so only your signed-in phone can call it.

const env = (k: string) => Deno.env.get(k) ?? "";
const MODEL = { default: env("AI_MODEL") || "claude-sonnet-5-5", quick: env("AI_MODEL_QUICK") || "claude-haiku-4-5-20251001" };
const MAX_BODY = 450_000;                      // a long statement PDF's text is the largest thing the app sends
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!env("ANTHROPIC_API_KEY")) return json({ error: "Claude isn't set up yet: add ANTHROPIC_API_KEY under Supabase → Edge Functions → Secrets.", type: "not_configured" }, 503);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ error: "That's too much text for one request.", type: "too_large" }, 413);
  let b: any; try { b = JSON.parse(raw); } catch (_) { return json({ error: "Bad request." }, 400); }
  const messages = Array.isArray(b.messages) ? b.messages.filter((m: any) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content) : [];
  if (!messages.length || messages[0].role !== "user") return json({ error: "Bad request." }, 400);

  const stream = !!b.stream && !b.json;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: b.tier === "quick" ? MODEL.quick : MODEL.default, max_tokens: b.json ? 16000 : 2048, messages, stream }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const type = e?.error?.type || "api_error";
    const msg = r.status === 429 ? "Too many requests to Claude. Try again in a minute."
      : r.status === 401 ? "The Anthropic API key was refused. Check ANTHROPIC_API_KEY."
      : /credit|billing/i.test(e?.error?.message || "") ? "Your Anthropic account is out of credit. Add some at console.anthropic.com → Billing."
      : e?.error?.message || "Claude didn't answer. Try again.";
    return json({ error: msg, type }, r.status);
  }
  // streamed answers pass straight through as server-sent events; JSON answers come back whole
  return new Response(r.body, { status: 200, headers: { ...CORS, "Content-Type": stream ? "text/event-stream" : "application/json", "Cache-Control": "no-cache" } });
});
