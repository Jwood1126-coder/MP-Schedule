// Ingredient lines for the recipe editor, one per line:
//   qty | unit | name | section | optional | note
// Only name is required. Example: "1 1/2 | lb | chicken thighs | Meat & Seafood"
import { parseQty, collapse } from './units.js';

const YES = new Set(['optional', 'opt', 'yes', 'y', 'true', '1']);
const NO = new Set(['', 'no', 'n', 'false', '0', 'required']);

export function parseIngredientLines(text, sections) {
  const items = [];
  const errors = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (collapse(line) === '') return;
    const n = i + 1;
    const parts = line.split('|').map((p) => collapse(p));
    if (parts.length > 6) {
      errors.push(`Line ${n}: too many "|" separators (max 6 columns).`);
      return;
    }
    const [qtyText = '', unit = '', name = '', sectionText = '', optText = '', note = ''] = parts;
    if (parts.length === 1) {
      // Just a name, like "salt".
      items.push({ qty: null, unit: '', name: parts[0], section: 'Other', optional: false, note: '' });
      return;
    }
    const qty = parseQty(qtyText);
    if (Number.isNaN(qty) || (qty != null && qty <= 0)) {
      errors.push(`Line ${n}: "${qtyText}" isn't a quantity. Use 2, 1.5, 1/2 or 1 1/2.`);
      return;
    }
    if (!name) {
      errors.push(`Line ${n}: the ingredient name (3rd column) is missing.`);
      return;
    }
    if (name.length > 100 || unit.length > 30 || note.length > 200) {
      errors.push(`Line ${n}: text is too long.`);
      return;
    }
    let section = 'Other';
    if (sectionText) {
      const match = (sections || []).find((s) => s.toLowerCase() === sectionText.toLowerCase());
      if (!match) {
        errors.push(`Line ${n}: unknown section "${sectionText}". Use one of: ${(sections || []).join(', ')}.`);
        return;
      }
      section = match;
    }
    const opt = optText.toLowerCase();
    if (!YES.has(opt) && !NO.has(opt)) {
      errors.push(`Line ${n}: 5th column should be "optional" or empty.`);
      return;
    }
    items.push({ qty, unit, name, section, optional: YES.has(opt), note });
  });
  return { items, errors };
}

export function formatIngredientLine(ing) {
  const cols = [ing.qty == null ? '' : String(round3(ing.qty)), ing.unit || '', ing.name, ing.section || 'Other'];
  if (ing.optional || ing.note) cols.push(ing.optional ? 'optional' : '');
  if (ing.note) cols.push(ing.note);
  return cols.join(' | ');
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}
