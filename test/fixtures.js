// Synthetic recipes for tests only.
export const recipes = {
  tacos: {
    id: 'tacos', name: 'Tacos', base_servings: 2, tags: ['workday-easy'],
    ingredients: [
      { qty: 1, unit: 'lb', name: 'Ground turkey', section: 'Meat & Seafood' },
      { qty: 1, unit: 'can (15 oz)', name: 'black beans', section: 'Canned & Jarred' },
      { qty: 0.5, unit: 'cup', name: 'salsa', section: 'Canned & Jarred' },
      { qty: 1, unit: '', name: 'avocado', section: 'Produce', optional: true },
      { qty: 1, unit: 'tsp', name: 'cumin', section: 'Spices' },
      { qty: null, unit: '', name: 'salt', section: 'Spices' },
    ],
  },
  chili: {
    id: 'chili', name: 'Chili', base_servings: 4, tags: ['freezer-friendly'],
    ingredients: [
      { qty: 1, unit: 'lb', name: 'ground turkey', section: 'Meat & Seafood' },
      { qty: 2, unit: 'cans (15 oz)', name: 'black beans', section: 'Canned & Jarred' },
      { qty: 2, unit: 'tbsp', name: 'salsa', section: 'Canned & Jarred' },
      { qty: 3, unit: 'cloves', name: 'garlic', section: 'Produce' },
      { qty: 2, unit: 'tsp', name: 'cumin', section: 'Spices' },
      { qty: 8, unit: 'oz', name: 'salsa', section: 'Canned & Jarred' },
    ],
  },
  soup: {
    id: 'soup', name: 'Soup', base_servings: 2, tags: ['healthy'],
    ingredients: [
      { qty: 1, unit: 'cup', name: 'lentils', section: 'Pantry' },
      { qty: 2, unit: '', name: 'carrot', section: 'Produce' },
      { qty: 1, unit: 'clove', name: 'garlic', section: 'Produce' },
    ],
  },
  bowls: {
    id: 'bowls', name: 'Bowls', base_servings: 2, tags: ['workday-easy', 'healthy'],
    ingredients: [
      { qty: 1, unit: 'cup', name: 'rice', section: 'Pantry' },
      { qty: 1, unit: '', name: 'avocado', section: 'Produce' },
      { qty: 0.5, unit: 'cup', name: 'salsa', section: 'Canned & Jarred' },
    ],
  },
};

export const settings = {
  sections: ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Pantry', 'Canned & Jarred', 'Frozen', 'Spices', 'Other'],
  staples: ['salt', 'olive oil'],
  default_servings: 2,
};
