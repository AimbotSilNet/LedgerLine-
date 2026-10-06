/* Ledgerline · your Supabase project (Supabase → Project Settings → API).
 * Both values are safe to publish: the anon key only works for signed-in users, and only on their own rows. */
window.LEDGERLINE_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "YOUR-ANON-PUBLIC-KEY",
  claude: true,   // Analysis, Ask, PDF statements and "sort with AI" through the `ai` function (needs ANTHROPIC_API_KEY); false turns them off
};
