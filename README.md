# Dinners: a two-person meal planner

A small private web app for planning a couple of dinners a week and getting one grocery list you both trust. Open it on your iPhones from the home screen.

- **Plan.** A week at a time. Mark busy days; they're preferred for easy dinners but never required. Swap, move, skip or change servings. "Suggest dinners" proposes ideas from your own recipes and saves nothing until you tap Add.
- **Month.** A calendar of what's planned. Dashed entries are ideas.
- **Groceries.** One list per shopping trip, with ingredients merged across dinners and grouped by store section. Mark "have it", add other items (paper towels, milk…), and copy the list as text. Build the cart yourself in the store's app, then tap **I built the cart: lock list**. That saves a record of what you bought. If you swap a dinner afterward, **Changes since shopping** shows what you still need and what's left over.
- **Recipes.** Your library, a cook view scaled to your servings, and an editor. Eight starter recipes are available for an empty library.
- **More.** Settings (stores, sections, pantry staples, the "busy day" label), history with undo, and backup/restore.

The app **never** places orders, fills a retailer cart or handles payment.

It runs on Cloudflare (Workers + D1 database + Access for sign-in) and should cost $0 at this scale.

## One-time setup (Cloudflare dashboard)

You do this once. Labels in the Cloudflare dashboard change from time to time, so **check the labels in the dashboard; they may differ slightly** from the ones below.

### 1. Connect the repository (deploys happen automatically)

1. In Cloudflare: **Workers & Pages → Create → Import a repository**, then pick this GitHub repository.
2. Build settings:
   - **Build command:** leave empty
   - **Deploy command:** `npx wrangler deploy`
3. Save and deploy.

The **database already exists** (`meal-planner` in D1) and is linked in `wrangler.jsonc`, so there's no D1 step in the dashboard. The Worker sets up its own tables on the first request.

From then on, every push to the main branch deploys automatically.

### 2. Turn on sign-in (Cloudflare Access)

Until this is done, the app's data stays locked: the page loads, but every data request is refused. It fails closed.

1. Open the Worker: **Workers & Pages → mp-schedule → Domains** (its own tab since May 2026; older docs say Settings → Domains & Routes).
2. Next to the `workers.dev` address, choose **Enable Cloudflare Access** (check the labels in the dashboard; they may differ slightly).
3. Cloudflare creates an Access application for that address. Edit its policy so it **allows exactly your two email addresses**, with the **One-time PIN** login method. Each of you then gets a code by email when signing in.
4. Note two values from the Access application (check the labels in the dashboard; they may differ slightly):
   - **Application Audience (AUD) Tag**: a long string
   - **Team domain**: like `https://your-team.cloudflareaccess.com`, under **Zero Trust → Settings**

### 3. Add the Worker secrets

In **Workers & Pages → mp-schedule → Settings → Variables and Secrets**, add two entries, each of type **Secret**:

| Name | Value |
|---|---|
| `POLICY_AUD` | the Application Audience (AUD) Tag |
| `ALLOWED_EMAILS` | both emails, comma-separated: `you@example.com,partner@example.com` |

The Worker checks Cloudflare's sign-in token on every request, plus the email against this list. These values live only in Cloudflare, never in GitHub, and deploys don't overwrite them.

`TEAM_DOMAIN` (your public sign-in address, like `your-team.cloudflareaccess.com`) is not secret, so it's set in `wrangler.jsonc` under `vars`. If you change your Zero Trust team name, update it there. Don't add `POLICY_AUD` or `ALLOWED_EMAILS` to `vars`: the repository is meant to stay free of household details.

### 4. Add it to your iPhone home screen

Open the app's `workers.dev` address in Safari, sign in, tap **Share → Add to Home Screen**. Do this on both phones.

## Everyday tips

- **Two phones at once.** If both of you change the same thing, the second save asks "keep theirs or use mine", so nothing is silently lost.
- **No signal?** A failed save shows **Not saved: retrying** and keeps your change until it goes through. If the app can't load, it shows the last saved copy, labelled as offline.
- **Undo.** More → History and undo.
- **Backup.** More → Download backup saves everything as a file. Keep it private: it contains your plans. "Restore from backup" replaces everything with a backup file.

## For developers

No build step and no frontend framework: plain HTML, CSS and JavaScript modules.

```
public/            static files served by Cloudflare (with _headers for CSP)
  js/core/         pure logic shared by browser and Worker: units, grocery list, diff, suggestions
  js/views/        Plan, Month, Groceries, Recipes, More
src/               the Worker: API routes, auth, versioned writes, schema
scripts/           local dev server (SQLite-backed D1 stand-in), checks, icon generator
test/              unit tests (node:test)
test-api/          API integration tests against the real Worker code
e2e/               browser tests at iPhone size (Playwright)
```

Requires Node.js 22.13 or newer.

```sh
cp .dev.vars.example .dev.vars   # local-only sign-in bypass (localhost only)
npm run dev                      # http://127.0.0.1:8787, data in .local-data/
npm run check                    # syntax-check every JS file
npm test                         # unit tests
npm run test:api                 # API tests
npm run test:e2e                 # browser tests (needs Playwright + Chromium)
npm run test:all
```

`npm run dev` runs the real Worker code with Node's built-in SQLite standing in for D1. `npm run dev:wrangler` uses Cloudflare's own local runtime instead, after `npm install`.

**Schema changes.** Migrations live in `src/schema.js`, and the Worker applies them itself on the first request. This keeps the deploy command to a single `npx wrangler deploy`. Append a new entry, and keep every statement idempotent (`IF NOT EXISTS`, `INSERT OR IGNORE`).

**Privacy.** The repository contains only code and invented test data (`example.com` addresses). Never commit `.dev.vars`, backups, real emails or household details.
