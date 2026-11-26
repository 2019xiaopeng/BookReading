// 依赖公告核查（R7；3.3 升级 zip / rusqlite 时重跑）：把 Cargo.lock 里全部 crate（含传递依赖）按版本批量查 OSV（收录 RustSec 公告）。
// 用法：node tools/deps-audit.mjs [Cargo.lock 路径]；直连失败自动改用 curl 走本机代理 127.0.0.1:7897。
import { readFileSync } from "node:fs";

const lock = readFileSync(process.argv[2] ?? "src-tauri/Cargo.lock", "utf8");
const pkgs = [];
for (const block of lock.split("[[package]]").slice(1)) {
  const name = /^name = "([^"]+)"/m.exec(block)?.[1];
  const version = /^version = "([^"]+)"/m.exec(block)?.[1];
  if (name && version) pkgs.push({ name, version });
}
const dup = new Map();
for (const p of pkgs) dup.set(p.name, [...(dup.get(p.name) ?? []), p.version]);
const multi = [...dup].filter(([, v]) => v.length > 1);

const queries = pkgs.map((p) => ({ package: { name: p.name, ecosystem: "crates.io" }, version: p.version }));
const body = JSON.stringify({ queries });
let results;
try {
  const r = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  ({ results } = await r.json());
  console.log("via: direct");
} catch (e) {
  // Node 22 的 fetch 不认代理环境变量：直连不通就用 curl 走本机代理
  console.log(`direct failed (${e.message}), retrying via curl + proxy 127.0.0.1:7897`);
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(
    "curl",
    [
      "-sS",
      "-m",
      "120",
      "-x",
      "http://127.0.0.1:7897",
      "-H",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "https://api.osv.dev/v1/querybatch",
    ],
    { input: body, maxBuffer: 64 << 20 },
  );
  ({ results } = JSON.parse(out.toString("utf8")));
  console.log("via: proxy");
}

const hits = [];
results.forEach((r, i) => {
  for (const v of r.vulns ?? []) hits.push({ ...pkgs[i], id: v.id, aliases: v.aliases ?? [] });
});
console.log(`crates: ${pkgs.length} (${dup.size} distinct names); queried: ${results.length}`);
console.log("multi-version crates:", multi.map(([n, v]) => `${n} ${v.join(" / ")}`).join("; ") || "none");
console.log(`known vulnerabilities: ${hits.length}`);
for (const h of hits) console.log(`  ${h.id}${h.aliases.length ? " (" + h.aliases.join(",") + ")" : ""}  ${h.name} ${h.version}`);
process.exit(0);
