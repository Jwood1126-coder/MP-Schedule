// App state: the last /api/state response plus helpers views share.
import { get, isNetworkError } from './api.js';
import { addDays, weekStart, localToday, daysBetween } from './core/dates.js';
import { buildList } from './core/grocery.js';

const CACHE_KEY = 'mp.state.v1';

export const store = {
  data: null,
  stale: null, // ISO time of the offline copy being shown, if any
  weekStart: weekStart(localToday()),
  month: localToday().slice(0, 7),
};

function monthGrid(month) {
  const first = `${month}-01`;
  const start = weekStart(first);
  return { start, end: addDays(start, 41) };
}

export function range() {
  const grid = monthGrid(store.month);
  let from = store.weekStart < grid.start ? store.weekStart : grid.start;
  let to = addDays(store.weekStart, 13) > grid.end ? addDays(store.weekStart, 13) : grid.end;
  if (daysBetween(from, to) > 120) {
    // Week and month far apart: just cover the week.
    from = store.weekStart;
    to = addDays(store.weekStart, 13);
  }
  return { from, to };
}

export async function refresh() {
  const { from, to } = range();
  try {
    const data = await get(`/api/state?from=${from}&to=${to}`);
    store.data = data;
    store.stale = null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ at: new Date().toISOString(), data }));
    } catch {
      /* ignore */
    }
    return data;
  } catch (err) {
    if (isNetworkError(err) && !store.data) {
      try {
        const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (cached && cached.data) {
          store.data = cached.data;
          store.stale = cached.at;
          return store.data;
        }
      } catch {
        /* ignore */
      }
    }
    if (isNetworkError(err) && store.data) {
      store.stale = store.stale || new Date().toISOString();
      return store.data;
    }
    throw err;
  }
}

export function recipesById() {
  return Object.fromEntries((store.data?.recipes || []).map((r) => [r.id, r]));
}

export function mealsOn(date) {
  return (store.data?.meals || []).filter((m) => m.date === date);
}

export function isPreferred(date) {
  const f = (store.data?.day_flags || []).find((d) => d.date === date);
  return { on: !!(f && f.preferred), version: f ? f.version : 0 };
}

export function tripFor(date) {
  return (store.data?.trips || []).find((t) => t.start_date <= date && date <= t.end_date) || null;
}

export function mealsInTrip(trip) {
  return (store.data?.meals || []).filter((m) => m.date >= trip.start_date && m.date <= trip.end_date);
}

export function tripList(trip) {
  return buildList(mealsInTrip(trip), recipesById(), trip.marks || [], store.data.settings);
}

// The trip to show by default: the one covering the next planned dinner
// (today or later), else one covering today, else the next upcoming, else
// the most recent.
export function defaultTrip() {
  const trips = [...(store.data?.trips || [])].sort((a, b) => a.start_date.localeCompare(b.start_date));
  const today = localToday();
  const upcoming = (store.data?.meals || [])
    .filter((m) => m.date >= today && (m.status === 'planned' || m.status === 'tentative'))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const meal of upcoming) {
    const t = trips.find((x) => x.start_date <= meal.date && meal.date <= x.end_date);
    if (t) return t;
  }
  return trips.find((t) => t.start_date <= today && today <= t.end_date)
    || trips.find((t) => t.start_date > today)
    || trips[trips.length - 1]
    || null;
}

// What was bought for a given meal (from its locked trip's snapshot).
export function boughtForMeal(meal) {
  const trip = tripFor(meal.date);
  if (!trip || trip.status !== 'locked') return null;
  const items = (trip.snapshot || []).filter((s) => s.purchase !== 'out' && (s.sources || []).some((src) => src.meal_id === meal.id));
  return { trip, items };
}
