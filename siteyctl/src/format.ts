export function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) =>
    Math.max(...all.map((r) => (r[i] ?? "").length)),
  );
  return all
    .map((r) =>
      r
        .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i])))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function ago(
  value: string | Date | null | undefined,
  now = Date.now(),
): string {
  if (!value) return "never";
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function keyValues(
  rows: [string, string | number | boolean | null | undefined][],
): string {
  const shown = rows.filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  const width = Math.max(...shown.map(([k]) => k.length));
  return shown.map(([k, v]) => `${`${k}:`.padEnd(width + 2)}${v}`).join("\n");
}
