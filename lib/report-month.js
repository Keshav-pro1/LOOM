export function monthKey(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 7);
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 7);
  }
  return "";
}

export function monthLabel(value, locale = "en-IN") {
  const key = monthKey(value);
  const [year, month] = key.split("-").map(Number);
  if (!year || !month) return "";
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}
