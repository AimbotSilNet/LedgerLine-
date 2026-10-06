# Ledgerline

**A private net-worth app for one person's iPhone.** It puts every account in one place (bank, cards, a brokerage account and a few alternatives) and answers two questions every time you open it: *where do things stand?* and *why?*

It started as a hand-kept Excel tracker, with a balance typed in for every account every few days. Ledgerline replaces that spreadsheet: balances, transactions and holdings arrive on their own through Plaid, and the app turns them into one honest number, the direction it's heading, and the reasons behind the change.

## What it does

Five tabs, each leading with exactly one number:

- **Worth** (home): total net worth and how it moved over the chosen range. It names the accounts that moved it most ("Savings +$715 · Credit card −$331"), followed by every account and the asset mix.
- **Portfolio**: investment value, today's move, total return and cash, with holdings, trades and allocation one tap below.
- **Income**: expected dividend income for the year, month by month, with who pays and when.
- **Budget**: what this month has cost against budget and against the same days last month. It covers categories, statement upload, voice entry and the transaction list.
- **Insights**: health checks such as concentration, idle cash, card utilization, stale balances, drop from peak and overspending. Each one states the figure it rests on and the limit it's measured against.

The app **describes and never recommends**. There are no "you should" suggestions, goals, streaks or badges. It shows what changed, what's worth a look, and the numbers behind both. Detail is always one tap below the summary.

## Inspirations

The visual direction is called **Terminal Precision on Lake Ashi**. It draws on three sources.

**A brokerage terminal.** The data side borrows a trading terminal's discipline:
- monospaced, tabular numerals, so a balance never jitters as it counts
- one signal colour
- borders and tone instead of shadows

The numbers carry no decoration, and the big figure on each tab is deliberately the loudest thing on screen.

**Lake Ashi in Hakone.** The setting is the lake at the foot of Mount Fuji:
- **Dark mode is dusk on the water** under the cedar slopes. **Light mode is the morning mist** that lies on the lake before 8 am.
- **The only accent colour is the vermilion of the torii gate** that stands in the lake at Hakone Shrine. In the app it means one thing: *you can tap this*.
- **Gains take the green of the Hakone forest. Losses take the rose of autumn maple**, kept distinct from the gate's red so "you lost money" never looks like "tap here".
- **Charts are drawn in "Fuji slate"**, the blue-grey of the mountain on a hazy day.

A handful of small details carry the place:
- Fuji and the torii stand behind the Worth header.
- The header's background rings behave like real water: touch them and they ripple, then settle.
- A small three-masted sightseeing galleon, after the pirate ships that cruise the lake, sails across the tab bar when you switch tabs.
- Section breaks use the triangle pattern of Hakone's *yosegi-zaiku* wood marquetry.
- Budget categories fill like little lakes, with a dashed shoreline at 100%.
- Every save is stamped with a *hanko* seal reading 済 ("done").
- The ripples change colour with Hakone's seasons: sakura in spring, hydrangea in June, maple in autumn, snow in winter.

**Apple's own apps.** The container is native iOS:
- large titles that collapse into a frosted navigation bar
- a floating glass tab bar
- system type
- bottom sheets that slide up and swipe away

It's built to feel at home when launched from the Home Screen.

## How it's built

```
iPhone (Home Screen web app)  ──►  Supabase (Postgres + Edge Functions)  ──►  Plaid (banks)
         app/                        supabase/                               Alpha Vantage (prices)
```

- **`app/`** is the site, served by Netlify. `index.html` is the whole app in one file, the same file that also runs as a Claude artifact. `shim.js` connects it to Supabase: sign-in, live data, bank connections and prices.
- **`supabase/1-schema.sql`** creates the tables (accounts, balances, transactions, holdings, trades, documents). Row-level security means every row is readable only by its owner.
- **`supabase/functions/plaid`** handles bank connections and syncing:
  - connects banks and imports balances, transactions, holdings and trades
  - keeps your own categories and edits across syncs
  - upgrades a pending transaction to its posted version without duplicating it
- **`supabase/functions/plaid-webhook`** receives Plaid's "new activity" notices.
- **`supabase/functions/prices`** keeps the Alpha Vantage key on the server.
- **`supabase/2-daily-sync.sql`** runs a background sync every six hours.
- **`SETUP.md`** walks through the whole setup in the browser, about 45 minutes.

## Privacy

There's no financial data and no secrets in this repository.
- `app/config.js` holds only the Supabase project URL and anon key, which are meant to be public: they only work for the signed-in owner's own rows.
- Bank access tokens live in a table the app itself can never read.
- The Plaid, Alpha Vantage and cron secrets live in Supabase's secret store.
- Backups, spreadsheets and statements are kept out of the repo by `.gitignore`.
