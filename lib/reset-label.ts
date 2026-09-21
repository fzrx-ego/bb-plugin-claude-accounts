// How long until a limit window resets.
//
// Hours stop being readable past a day: "456h 39m" is a Cursor billing cycle,
// not a number anyone converts in their head. So the unit follows the
// distance — minutes, hours, days, and a plain date once it is more than a
// week out.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** "in 42m" | "in 5h 26m" | "in 3d 4h" | "on 10 Oct" — null when past. */
export function resetLabel(
  resetsAt: string | null,
  now: number = Date.now(),
): string | null {
  if (resetsAt === null) return null;
  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return null;

  if (remaining < HOUR) {
    return `in ${Math.max(1, Math.round(remaining / MINUTE))}m`;
  }
  if (remaining < DAY) {
    const minutes = Math.round(remaining / MINUTE);
    return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (remaining < WEEK) {
    const hours = Math.round(remaining / HOUR);
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest === 0 ? `in ${days}d` : `in ${days}d ${rest}h`;
  }
  const date = new Date(target);
  const day = date.getDate();
  const month = date.toLocaleString("en-US", { month: "short" });
  // Same year is the common case; a cycle crossing New Year says which year.
  const year =
    date.getFullYear() === new Date(now).getFullYear()
      ? ""
      : ` ${date.getFullYear()}`;
  return `on ${day} ${month}${year}`;
}
