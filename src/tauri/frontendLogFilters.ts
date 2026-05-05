export function shouldIgnoreWindowErrorMessage(message: string): boolean {
  const m = (message ?? "").trim();
  if (!m) return true;
  if (m.includes("ResizeObserver loop completed")) return true;
  if (m.includes("ResizeObserver loop limit exceeded")) return true;
  return false;
}

