# 批次23（=M2 U1）：纸墨/墨夜主题注册 + M2 token 层

执行：U1 代理。范围：tokens.css、weread.css、theme.ts(+test)、types.ts、normalize.ts(+test)、reader.ts THEME_STYLES。
验收：vitest 全量 21 文件 150 用例绿；npx tsc 零错；三副本色值 grep 对照一致。

- Theme 增 "ink"|"ink-dark"（8 套），normalizeTheme 未知回退 light→ink（新默认生效），THEME_SWATCHES 增两墨色块（三处色块菜单零改动自动多格），color-scheme ink→light / ink-dark→dark
- tokens.css：既有 9 变量两块覆盖（--panel-solid ink #FFFFFF / ink-dark #201F1D）+「M2 纸墨层」小节八组 12 变量（--m2-paper/ink/ink-soft/line/cover-line/wash/ink-ghost/skeleton/sheen/shadow/cover-filter/noise）；旧六主题按 §2 推导规则（paper=--bg、ink=--text 近似、alpha 族按 16/20/5/35%）
- weread.css：ink/ink-dark 完整 --wr-* 块；**两套 accent 均重定义为墨**（ink #242321/反白纸，ink-dark #EDECE7/反墨夜纸）——"换主题=换墨"红线；--wr-chrome-bg 纸墨半透（U6 毛玻璃用）
- reader.ts THEME_STYLES：ink {#FAFAF7/#242321}、ink-dark {#191816/#EDECE7}，opaque 注入路径，inkRgb 同步
- 高亮黄 #ffe600 保留（§11.7）；光斑未动（U6 作用域删除）

遗留：dark/darkcontrast 的组件级 alpha 微调（约 26 处）在 ink/ink-dark 未镜像——基础规则全走 rgb 变量自动随墨，U4-U6 视觉批次定夺。
