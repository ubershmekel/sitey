/**
 * Date helpers for analytics rollups. All computed in UTC.
 *
 * `day`  → yyyymmdd integer (e.g. 20260605)
 * `week` → ISO-8601 year-week integer as (ISO-year * 100 + ISO-week), e.g.
 *           202623. The ISO week-numbering year can differ from the calendar
 *           year around the Dec/Jan boundary, so it is computed via the
 *           Thursday-of-the-week rule rather than the calendar year.
 */

/** yyyymmdd in UTC for a unix-seconds timestamp. */
export function utcDayNumber(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return (
    d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  );
}

/** ISO year-week as (isoYear * 100 + isoWeek) in UTC. */
export function isoYearWeek(unixSeconds: number): number {
  const src = new Date(unixSeconds * 1000);
  // Work on a date-only value at UTC midnight.
  const date = new Date(
    Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()),
  );
  // Shift to the Thursday of the current ISO week (Mon=0 … Sun=6).
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();
  // First Thursday of the ISO year.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week =
    1 +
    Math.round(
      (date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000),
    );
  return isoYear * 100 + week;
}
