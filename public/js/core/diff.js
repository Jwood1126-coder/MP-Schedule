// Compare what was bought (the locked snapshot) with what the plan needs now.
// Used after a swap, skip or move on a trip that was already shopped.
import { formatBase } from './units.js';
import { purchaseQty } from './grocery.js';

const EPS = 1e-6;

// snapshotItems: rows from snapshot_items ({item_key, name, qty, dim, unit, metric, purchase, sources, section})
// currentList: items from buildList()
export function afterShopping(snapshotItems, currentList) {
  const bought = new Map();
  for (const s of snapshotItems || []) {
    if (s.purchase === 'out') continue; // out of stock = not bought
    bought.set(s.item_key, s);
  }
  const stillNeed = [];
  const covered = [];
  const usedKeys = new Map();

  for (const item of currentList || []) {
    if (item.have) continue;
    const need = purchaseQty(item);
    const snap = bought.get(item.key);
    const got = snap ? Number(snap.qty) : 0;
    usedKeys.set(item.key, need);
    if (snap && (need == null || snap.qty == null || got + EPS >= need)) {
      covered.push({ ...item, substituted: snap.purchase === 'substituted', sub_note: snap.sub_note || '' });
    } else {
      const missing = need == null ? null : need - got;
      stillNeed.push({
        ...item,
        missing,
        missingText: missing == null ? item.text : fmt(item.dim, missing, item),
        partial: got > 0,
      });
    }
  }

  const boughtUnused = [];
  for (const [key, snap] of bought) {
    const used = usedKeys.has(key) ? usedKeys.get(key) : 0;
    const qty = snap.qty == null ? null : Number(snap.qty);
    if (!usedKeys.has(key) || (qty != null && used != null && qty - used > EPS)) {
      const leftover = qty == null ? null : qty - (used || 0);
      const sources = typeof snap.sources === 'string' ? JSON.parse(snap.sources) : snap.sources || [];
      boughtUnused.push({
        key,
        name: snap.name,
        section: snap.section,
        leftover,
        leftoverText: leftover == null ? '' : fmt(snap.dim, leftover, { metric: !!snap.metric, countUnit: snap.dim === 'count' ? snap.unit : '' }),
        wholeItem: !usedKeys.has(key),
        substituted: snap.purchase === 'substituted',
        sources,
      });
    }
  }
  return { stillNeed, boughtUnused, covered };
}

function fmt(dim, qty, { metric, countUnit }) {
  if (dim === 'count') return `${Math.round(qty * 100) / 100}${countUnit ? ` ${countUnit}` : ''}`;
  return formatBase(dim, qty, { metric, countUnit }).text;
}
