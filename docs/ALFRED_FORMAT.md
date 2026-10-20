# Alfred's weekly plan format

Alfred proposes dinners; Jacob and Jess review and accept them in the app.
A proposal is **one JSON object**. Put it in a `json` code block in the body
of a new page in the Notion **Meal plan inbox** database, with:

- **Name**: e.g. `Week of Nov 9`
- **Status**: `Proposed` (the app only shows pages marked Proposed)
- **Week of**: the Monday of that week

The same JSON can also be pasted into the app (More → Paste a plan from Alfred).

## Example (synthetic)

```json
{
  "week_of": "2026-11-09",
  "message": "Two easy dinners on the busy days; the chili doubles as lunch.",
  "busy_days": ["2026-11-10", "2026-11-12"],
  "dinners": [
    { "date": "2026-11-10", "recipe": "Turkey and bean chili", "servings": 4, "note": "lunch tomorrow", "alternate": "Lentil vegetable soup" },
    { "date": "2026-11-12", "recipe": "Sheet-pan salmon", "servings": 2 }
  ],
  "new_recipes": [
    {
      "name": "Sheet-pan salmon",
      "base_servings": 2,
      "active_min": 10,
      "total_min": 25,
      "pans": 1,
      "tags": ["workday-easy", "healthy"],
      "source_url": "https://example.com/sheet-pan-salmon",
      "prep_note": "Thaw the salmon in the fridge the night before.",
      "steps": "Heat the oven to 425°F.\nToss green beans with oil and salt.\nRoast salmon and beans 12–15 minutes.",
      "ingredients": [
        "1 | lb | salmon fillets | Meat & Seafood",
        "12 | oz | green beans | Produce",
        "1 | | lemon | Produce | optional",
        "salt"
      ]
    }
  ],
  "extras": ["milk", "bananas"]
}
```

## Fields

| Field | Required | Rules |
|---|---|---|
| `week_of` | yes | Monday, `YYYY-MM-DD`. Every date below must fall in this week. |
| `message` | no | Short note shown at the top of the plan, max 500 characters. |
| `busy_days` | no | Up to 7 dates. The app marks them as busy (preferred) days, e.g. Jess's workdays. Dates only, no shift details. |
| `dinners` | yes | 1–7 dinners. |
| `dinners[].date` | yes | `YYYY-MM-DD` within the week. |
| `dinners[].recipe` | yes | A recipe **name**. Matches the app's library ignoring case and extra spaces; otherwise it must be in `new_recipes`. |
| `dinners[].servings` | no | Whole number 1–20. Defaults to the app's default servings. |
| `dinners[].note` | no | Max 300 characters, shown under the dinner. |
| `dinners[].alternate` | no | Another recipe name (library or `new_recipes`). Jacob or Jess can tap ↺ to use it instead. |
| `new_recipes` | no | Up to 14. Only recipes a chosen dinner uses are added to the library; a name already in the library uses the library version. |
| `new_recipes[].name` | yes | Max 100 characters. |
| `new_recipes[].base_servings` | yes | 1–20; ingredient amounts are for this many servings. |
| `new_recipes[].active_min`, `total_min`, `pans` | no | Whole numbers. |
| `new_recipes[].tags` | no | Any of `workday-easy`, `freezer-friendly`, `make-ahead`, `leftover-friendly`, `healthy`. Unknown tags are dropped. |
| `new_recipes[].source_url` | no | `https://` link to the original recipe. Link rather than copying the whole recipe. |
| `new_recipes[].prep_note` | no | Thawing or make-ahead step, max 500. |
| `new_recipes[].steps` | no | Text with one step per line (or a list of strings), max 5000. |
| `new_recipes[].ingredients` | yes | One string per ingredient: `qty \| unit \| name \| section \| optional`. Quantities like `2`, `1.5`, `1/2`, `1 1/2`. Leave the unit empty for counts (`1 \| \| lemon \| Produce`). A bare name (`salt`) is fine for pantry items. Sections: Produce, Meat & Seafood, Dairy & Eggs, Bakery, Pantry, Canned & Jarred, Frozen, Spices, Other. |
| `extras` | no | Up to 40 non-dinner grocery items (text, max 120 each). Added to that week's grocery list. |

## What happens next

- The app shows the plan on the **Plan** tab. Each dinner can be kept (✓),
  swapped to its alternate (↺) or skipped (✕), and there's an optional note.
- **Accept** adds the chosen dinners, any needed new recipes, the busy days and
  the extras (on that week's grocery trip, created if needed). It can't be
  applied twice.
- The app then sets the Notion page's **Status** to `Accepted`, `Partly
  accepted`, `Changes requested` (Send back) or `Declined`, and writes a
  **Reply**: what was accepted or skipped, the note, and the current recipe
  library names, so the next proposal can reuse them.
- After **Send back**, revise the same page and set Status back to `Proposed`.
- If something can't be read (bad date, unknown recipe, bad ingredient line),
  the app shows the exact problem and won't accept until it's fixed.
