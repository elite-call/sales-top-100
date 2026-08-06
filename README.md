# Sales Team Top 100

A ranked list of the most valuable unsold prospects in Zoho CRM, rebuilt every morning and published as a static page. Two brands share one report: roofing work routes to Hail 911, everything else to Elite Call.

- `Sales Team Top 100.dc.html` — the console. Search, filter by owner/stage/industry/brand, sort any column, expand a row for the score breakdown, deep-link into Zoho, export the current view to CSV, and drag the weight sliders to re-rank live.
- `Top 100 Graphic.dc.html` — a 1600×900 hero card of today's podium, for Slack or a slide.
- `data/top100.json` — today's ranked data. The only thing the pages read.
- `data/snapshots/YYYY-MM-DD.json` — one file per day, which is what powers the ▲▼ rank movement.

## Why GitHub Actions and not Google Apps Script

A scheduled workflow runs `scripts/build.js`, which refreshes the Zoho token, pulls open deals, scores them, and commits `data/top100.json` back to the repo. Every daily commit is itself the snapshot, so history and audit come free. Secrets live in GitHub, there is no second platform to maintain, and the page is static — nothing to keep running.

Apps Script is the better choice in exactly one case: if non-engineers need to edit the scoring weights in a spreadsheet. If that becomes a requirement, the weights move to a Sheet and the workflow reads it before scoring; the rest of the pipeline is unchanged.

## If you are used to Apps Script

Same shape, different host. Nothing here is a new concept, only a new place for each piece to live:

| Apps Script habit | Here |
|---|---|
| Time-driven trigger | The `schedule: cron` line in `.github/workflows/daily.yml` |
| Your `.gs` code | `scripts/build.js` and `scripts/score.js`, run by Node on a GitHub machine |
| Script Properties for keys | Repository Secrets |
| A Sheet or relational table | `data/top100.json` — the repo is the database |
| `GitHub API push from script` | The workflow's own `git commit && git push` step |
| Published web app / Sheet view | GitHub Pages serving the static page |

There is no database to run because the output is one small JSON file, and its version history is the commit log. Yesterday's file is still in the repo, which is exactly what the ▲▼ movement reads.

## The score

Seven components. Each earns a fraction of the points available to it, and the total is the score out of 100. Default weights, tunable in `scripts/config.json`:

| Component | Weight | What it measures |
|---|---|---|
| Revenue potential | 22 | First-campaign estimate, log-scaled between $1k and $50k |
| Pipeline stage | 18 | Hand-set probability per stage (Pending Revenue 0.95 → Stale 0.15) |
| Engagement depth | 14 | How many of 10 signals are populated on the record |
| Industry fit | 14 | Historical win rate for that industry |
| Recency of contact | 12 | Exponential decay, 75-day half-life on last activity |
| Lead source quality | 10 | Historical win rate for that source |
| Call intelligence | 10 | Trellus transcript quality — **neutral 5/10 until connected** |

Industry and source fit are not guesses. The build reads every closed record in the module and computes a win rate per category, Laplace-smoothed toward the house average (44% in the current export) so a category with one closed deal cannot spike to 100%. In the current data Roofing Residential converts at 70% and Medical at 12%, which is why a $12k roofing prospect outranks a $16k medical one.

Every row carries a `summary`: a deterministic sentence set naming the two components that lifted it, the one holding it back, the stage-appropriate next move, and an explicit note that call intelligence is still neutral. No AI, no API key, no cost, and the same input always produces the same words.

`score` in the JSON is the weighted total out of 100, the same number and scale the page displays. Tier and grade bands derive from it.

## Setup

### 1. Zoho credentials

Use a **Self Client**, not the authorization-code flow — there is no browser in a scheduled job, so no redirect URI is needed.

1. Go to <https://api-console.zoho.com> → **Self Client** → Create.
2. Copy the **Client ID** and **Client Secret**.
3. On the **Generate Code** tab, enter this scope:
   ```
   ZohoCRM.modules.deals.READ,ZohoCRM.modules.leads.READ,ZohoCRM.settings.fields.READ
   ```
   Set duration to 10 minutes, pick your CRM portal, and generate. Copy the grant code — it expires fast.
4. Exchange the code for a refresh token (run this within those 10 minutes):
   ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -d "grant_type=authorization_code" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "code=THE_GRANT_CODE"
   ```
   Save the `refresh_token` from the response. It does not expire — it is the only long-lived secret.

Replace `.com` with your data center (`.eu`, `.ca`, `.in`, `.com.au`) in both the console URL and the curl call.

### 2. GitHub configuration

Repository **Settings → Secrets and variables → Actions**:

Secrets: `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`

Variables: `ZOHO_DC` (`com`, `eu`, `ca`, `in`, `com.au`), `ZOHO_ORG_ID` (from Zoho → Setup → Company Details; makes the row deep-links resolve to your org)

Then **Settings → Pages → Source: GitHub Actions**. Keep the repo private and Pages will require a login, which is the right default for CRM data.

### 3. Field API names

Zoho's API uses internal field names that rarely match the labels. Print yours:

```bash
npm run discover          # Deals
npm run discover Leads
```

Paste the API names into the `fields` block of `scripts/config.json`. The ones most likely to differ in your org are `Estimate_1st_Campaign`, `Industry_type`, `Internal_Company`, `In_Talks`, `Top_Priority`, `Warboard`, `BDR_Agent`, and `Closing`. Anything set to `null` is skipped.

### 4. Run it

```bash
npm run build                              # live pull from Zoho
npm run build:csv path/to/export.csv       # offline, from a CRM export
npm run serve                              # preview the page locally
```

The workflow runs at 11:00 UTC daily (about 6am Central) and can also be triggered by hand from the Actions tab.

## Tuning

`scripts/config.json` holds everything you would want to change without touching code: weights, per-stage probabilities, the revenue floor/cap, recency half-life, tier and grade cutoffs, brand routing rules, and the field map. The sliders on the page let a rep explore different weightings in their browser; only `config.json` changes what gets published.

## Connecting Trellus

Call intelligence is wired but inert: every prospect gets a neutral 5 of 10 so the component neither helps nor hurts, and the page says so. To turn it on, expose a 0–100 transcript-quality number per record and either

- write it to a Zoho field and set `fields.trellusScore` to its API name, or
- fetch it in `scripts/build.js` and set `trellus` on each record before scoring.

`scripts/score.js` needs no changes either way.

## Known data gaps

Carried in `data/top100.json` under `gaps` and shown at the bottom of the page:

- `Amount` is populated on only 16 of 3,080 open records, so `Estimate - 1st Campaign` (1,857 populated, $12k median) is the revenue signal. Records with neither fall back to the category median and are labelled *inferred* in the detail panel.
- No headcount or company-size field exists in the export, so company-size fit is unscored.
- Sinch SMS counters exist but are empty.
- Call transcript quality is not yet connected.

## Layout

```
.github/workflows/daily.yml   cron → build → commit → deploy Pages
scripts/config.json           weights, stages, brands, field map
scripts/zoho.js               OAuth refresh + paged record pull
scripts/build.js              orchestration, snapshots, CSV fallback
scripts/score.js              the model and the summary writer
scripts/discover.js           prints field API names
data/top100.json              today's output
data/snapshots/               one file per day, powers ▲▼
```
