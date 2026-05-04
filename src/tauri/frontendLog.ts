import { appendFrontendLog } from "./invoke";

let queued: string[] = [];
let flushing = false;

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queued.length) {
      const chunk = queued.splice(0, 10);
      for (const line of chunk) {
        try {
          await appendFrontendLog(line);
        } catch {
        }
      }
    }
  } finally {
    flushing = false;
  }
}

export function logFrontend(line: string): void {
  queued.push(line);
  void flush();
}

export function installFrontendLogging(): void {
  window.addEventListener("error", (ev) => {
    const e: any = (ev as any).error;
    logFrontend(`window.error: ${String(ev.message)}\n${String(e?.stack ?? "")}`);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const r: any = (ev as any).reason;
    logFrontend(`unhandledrejection: ${String(r)}\n${String(r?.stack ?? "")}`);
  });

  const orig = console.error.bind(console);
  console.error = (...args: any[]) => {
    try {
      logFrontend(`console.error: ${args.map((a) => String(a)).join(" ")}`);
    } catch {
    }
    orig(...args);
  };
}

