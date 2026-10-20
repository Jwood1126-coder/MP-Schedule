// Date helpers on plain 'YYYY-MM-DD' strings, computed in UTC so they never
// shift with the device's time zone.
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(s) {
  return new Date(`${s}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}

// Monday of the week containing s.
export function weekStart(s) {
  return addDays(s, -((weekday(s) + 6) % 7));
}

export function weekDates(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDay(s) {
  return DAY_SHORT[weekday(s)];
}

export function prettyDate(s) {
  const [, m, d] = s.split('-').map(Number);
  return `${shortDay(s)} ${MONTHS[m - 1]} ${d}`;
}

export function monthName(s) {
  const [y, m] = s.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}

// Local "today" as YYYY-MM-DD (browser/device time zone).
export function localToday(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
