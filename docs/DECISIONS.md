# Scope decisions (v1)

These decisions come from the Notion page **"Meal planning · Discovery brief for Claude"**, where the planning and its reasoning are recorded. This file summarizes them for anyone reading the code.

## What v1 is

- **v1 is the pilot.** The app was built first, rather than trialing the workflow in Notion. Real use over a few weeks decides what changes next.
- **Two dinners a week**, with servings set per dinner (default 2).
- **Preferred days** (busy days) are toggled by hand per date. Suggestions favor them and pick workday-easy recipes for them, but they're never required.
- **Health and ease come before the lowest price.** Recipes carry tags (workday-easy, healthy, freezer-friendly, make-ahead, leftover-friendly), active and total minutes, and pan count. There are no calorie or nutrition numbers.
- **Stores:** Giant Eagle and Lucky's are presets; you choose the store per trip, and free text is allowed.
- **Shopping is manual.** The app produces a merged, grouped list that can also be copied as text. You build the cart in the store's own app or website; review and payment always stay with a person. There is no retailer automation, ordering, checkout or payment in any form.
- **Shopping snapshot.** "I built the cart: lock list" saves what was bought, once, and later edits never rewrite it. Plan changes afterward show as "still need" or "bought but no longer planned".

## Deliberately not built (yet)

- Live prices and price estimates
- Nutrition figures
- Full pantry inventory (there's a per-trip "have it" toggle plus a pantry staples list)
- AI-generated recipes
- Calendar connection
- Notifications
- Offline editing (there's a labelled read-only offline copy and a retry queue for failed saves)

## Kept possible for later

Whole-household grocery shopping, including bulk trips such as Costco, is a possible later expansion and is **not in scope now**. The design doesn't block it: trips have their own store, there are free-form "other items", and several trips can exist.

## Architecture

- **Cloudflare, under the household's own account:**
  - one Worker serves the static app and a JSON API
  - D1 (SQLite) holds the data, created automatically on first deploy
  - Cloudflare Access handles sign-in, with an email one-time PIN for exactly two people
- **Defense in depth:** the Worker verifies the Access token and checks the email against an allow-list, and fails closed if not configured. There are CSRF checks on writes, a strict Content Security Policy, and no `innerHTML` with data.
- **Shared state** has versioned rows: a conflicting save is refused and the person chooses "keep theirs" or "use mine". A change log powers history and undo. The app refreshes on focus and every 30 seconds.
- **Exit path:** a full JSON export and import.
