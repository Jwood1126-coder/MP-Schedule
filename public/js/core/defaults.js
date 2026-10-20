// Default settings. Stored values (settings table) override these per key.
export const SECTIONS = [
  'Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Pantry',
  'Canned & Jarred', 'Frozen', 'Spices', 'Other',
];

export const DEFAULT_SETTINGS = {
  sections: SECTIONS,
  // Only these are assumed to be in the pantry; everything else is on the list
  // until someone marks it "have".
  staples: ['olive oil', 'butter'],
  default_servings: 2,
  preferred_label: 'Busy day',
  default_store: 'Giant Eagle',
  stores: ['Giant Eagle', "Lucky's"],
  dinners_per_week: 2,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export const TAGS = ['workday-easy', 'freezer-friendly', 'make-ahead', 'leftover-friendly', 'healthy'];

export function mergeSettings(rows) {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows || []) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, row.key)) out[row.key] = row.value;
  }
  return out;
}
