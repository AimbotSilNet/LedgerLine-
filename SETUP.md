# Ledgerline on your iPhone: setup

Do this on your Mac, in the browser. Allow about 45 minutes, plus however long Plaid takes to approve you.
Secrets only ever go into the Supabase dashboard. Never paste them into chat, and never put them in `config.js`.

What's in this folder:
- `app/` is the website your iPhone opens. It's the Ledgerline app plus `shim.js`, which connects it to Supabase, Plaid and Claude.
- `supabase/1-schema.sql` sets up the database tables (DATA.md).
- `supabase/2-daily-sync.sql` turns on a bank sync every 6 hours.
- `supabase/functions/` holds the four server functions: `plaid`, `plaid-webhook`, `prices` and `ai`.

## 1. Supabase project (10 min)
1. Go to **supabase.com** → **New project**.
   - Name: `Ledgerline`
   - Region: **Canada (Central)**
   - Set a database password and save it.
   - Wait for the project to finish starting.
2. Go to **SQL Editor** → **New query**. Paste all of `supabase/1-schema.sql` → **Run**. You should see "Success. No rows returned".
3. Go to **Authentication** → **Users** → **Add user** → **Create new user**.
   - Enter your email and a password.
   - Tick **Auto Confirm User** → **Create user**.
4. Go to **Authentication** → **Sign In / Providers** and turn **off** "Allow new users to sign up". You're the only user.
5. Go to **Project Settings** → **API Keys** and copy two things:
   - your **Project URL** (`https://xxxx.supabase.co`)
   - the **anon / publishable** key
6. Open `app/config.js` in TextEdit. Replace the two `YOUR-…` placeholders with those values and save.

## 2. Plaid account (10 min, plus approval)
1. Go to **dashboard.plaid.com/signup** and verify your identity. You'll get the free **Trial plan**:
   - up to 10 bank logins, in Canada
   - includes Transactions and Investments
2. Go to **Developers** → **Keys** and copy your **client_id** and your **Production secret**.

You don't need a redirect URI, because Canadian banks don't use OAuth in Plaid.

### Claude API key (5 min)
This powers the written Analysis, Ask, reading PDF statements and "sort with AI". It's billed per use by Anthropic, separately from a Claude subscription.
1. Go to **console.anthropic.com** and sign up or sign in.
2. Go to **Billing** and add a small amount of credit.
3. Go to **Settings** → **Limits** and set a monthly spend limit you're comfortable with, so costs can't run away.
4. Go to **API Keys** → **Create Key**, name it `Ledgerline`, and copy it. It's shown only once, and you'll paste it in step 3.

If you'd rather skip Claude, set `claude: false` in `app/config.js` and leave out the `ai` function.

## 3. Server functions (10 min)
Do this in Supabase → **Edge Functions**, four times:
1. Click **Deploy a new function** → **Via Editor**.
2. Name it `plaid`. Delete the sample code, paste all of `supabase/functions/plaid/index.ts`, then click **Deploy**.
3. Do the same for `plaid-webhook`, `prices` and `ai`, each with its own `index.ts` from `supabase/functions/`.
4. Open each function's **Details** and set **Verify JWT** (also called *Enforce JWT verification*):
   - `plaid`: **OFF**
   - `plaid-webhook`: **OFF**
   - `prices`: **ON**
   - `ai`: **ON**

   `plaid` checks your sign-in itself. Plaid's own calls to `plaid-webhook` can't carry a Supabase sign-in.

Then go to **Edge Functions** → **Secrets** and add these six:

| Name | Value |
|---|---|
| `PLAID_CLIENT_ID` | your Plaid client_id |
| `PLAID_SECRET` | your Plaid **Production** secret |
| `PLAID_ENV` | `production` |
| `CRON_SECRET` | any long random text, e.g. 40 random letters and numbers. Keep a copy for step 4. |
| `ALPHAVANTAGE_KEY` | your free key from alphavantage.co |
| `ANTHROPIC_API_KEY` | the Claude API key from step 2 |

## 4. Background sync (2 min)
1. Open `supabase/2-daily-sync.sql` and replace the two placeholders:
   - `YOUR-PROJECT-REF` is the part before `.supabase.co` in your Project URL.
   - `YOUR-CRON-SECRET` is the same value as the secret above.
2. Paste the file into **SQL Editor** → **Run**.

If it says an extension isn't available, go to **Database** → **Extensions**, turn on **pg_cron** and **pg_net**, then run it again.

## 5. Put the app online (5 min)
1. Go to **app.netlify.com** → **Add new site** → **Deploy manually**.
2. Drag the **`app`** folder onto the page.
3. Go to **Site configuration** → **Change site name** and pick something like `ledgerline-daniel`. Your address is now `https://ledgerline-daniel.netlify.app`.

To update the app later, open **Deploys** and drag the `app` folder in again.

## 6. Move your data over (5 min, on the Mac)
1. Open your **Ledgerline – FINAL** page in Claude → **Settings** (gear) → **Back up everything** → **Download**.
2. Open your Netlify address in Safari or Chrome on the Mac and sign in with the Supabase user from step 1.
3. Go to **Settings** → **Restore from backup** → **Choose file** and pick the backup. Your accounts, history, holdings and spending appear.

## 7. Put it on your iPhone (1 min)
1. Open your Netlify address in **Safari** on the iPhone and sign in.
2. Tap **Share** → **Add to Home Screen** → **Add**. It now opens full screen from the torii icon.

## 8. Connect your banks
1. In the app on Worth, tap **+ Add bank account** → **Connect with bank**.
2. Pick your bank and sign in.
3. For each account Plaid finds, choose what happens:
   - **Same as …** (pick the account you already track) keeps its history.
   - **Add as a new account** creates a new one.
   - **Don't track** skips it.
4. Tap **Save and sync**.
5. Repeat for each of your other banks.

One sign-in covers every account at that bank, including its credit cards, and counts as one of your 10 Trial logins. Deleting a connection doesn't give the slot back.

For a brokerage, use **+ Add investment account** → **Connect with bank**. Plaid's coverage of Canadian brokerages is patchy. If yours isn't offered or the connection fails, keep that account manual and log trades with **+**.

After this, new activity arrives on its own: Plaid notifies the server as it happens, and the 6-hourly sync is the backup. Opening the app or tapping refresh also syncs.

## Good to know
- **Claude on the phone:** Claude only runs when you tap something: **Generate summary** on the Insights tab, Ask, PDF statements and "sort with AI". Each one is a small charge on your Anthropic account. When you ask, your server sends Claude a summary of your accounts, holdings and recent transactions; nothing else gets it.
- **Alpha Vantage's free key allows 25 requests a day.** The app refreshes prices at most every 4 hours. With many tickers, some days the limit runs out and prices update the next day.
- **Free Supabase projects pause after about a week with no use.** Opening the app keeps it awake. If it ever pauses, click **Restore** in the Supabase dashboard.
- **If a bank needs you to sign in again,** a banner appears on Worth with **Reconnect**.
