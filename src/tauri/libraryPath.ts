function normalizeSeps(s: string): string {
  return s.split("\\").join("/");
}

export function coerceToLibraryRelPath(input: string, appDataBase?: string): string | null {
  const v = normalizeSeps(input.trim());
  if (!v) return null;

  const lower = v.toLowerCase();
  if (lower.startsWith("library/")) return v;

  if (appDataBase) {
    const base = normalizeSeps(appDataBase).replace(/\/+$/, "");
    if (lower.startsWith(base.toLowerCase())) {
      const sliced = v.slice(base.length).replace(/^\/+/, "");
      if (sliced.toLowerCase().startsWith("library/")) return sliced;
    }
  }

  const idx = lower.indexOf("/library/");
  if (idx !== -1) return v.slice(idx + 1);

  return null;
}

