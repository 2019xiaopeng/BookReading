// 「自动整理」(V-8) 规则试算：把设想的规则跑在真实书库上，输出每条规则会触及的数量。只读，不写任何数据。
// 页面侧代码在 dryrun-organize.page.js（独立文件，可用 node --check 校验）。
// 用法：node tools/cdp/dryrun-organize.mjs   （需真实 dev 窗口在 9223；输出只有计数，不含书名）
import { readFileSync } from "node:fs";

import { connect } from "./cdp-lib.mjs";

const source = readFileSync(new URL("./dryrun-organize.page.js", import.meta.url), "utf8");
const c = await connect(9223);
try {
  console.log(await c.evaluate(source));
} finally {
  c.close();
}
process.exit(0);
