# 2026-10-27 批次7 · Hallmark 产品化打磨 — 变更记录

tokens 收编：主题块外零字面量颜色（新增 --wr-panel-bg/--wr-reader-paper-bg/--wr-chrome-bg/--wr-scrim/--wr-cover-*-ink/--wr-ink-rgb/--wr-shadow-*/--wr-accent-2-rgb/--wr-radius-sm|xs）；html/body overflow-x:clip。
导入按钮：根因=dark 主题 .wr-btn 特异性压制 primary——提权+实色 accent-deep（浅色系加深至 13,117,12），六主题对比 5.89-8.66 全达标。
状态四件套：.wr-state（空/加载/错误）接入全部页面与面板；17 处 alert/confirm 清零→src/ui/dialog.tsx（showAlert/showConfirm，危险钮 --wr-danger）。
favicon.svg（书本）+ title "BookReading · 阅读" + meta description；删 vite/react 模板残留。
装饰渐变清理：封面光泽/body wash/主按钮渐变/进度填充渐变/装饰状态点删除；进度填充改 scaleX transform。
密度第四档 xl（特大 420px，封面 120x172，标题 17px）。
focus-visible/reduced-motion 终查：书卡键盘可达（Tab+Enter/Space）、range focus、21 交互类全覆盖、新增动画独立 reduce 回退。
sloplint：静态层过（render 层无 puppeteer 跳过）；剩余项均有豁免理由（自有设计体系/space 刻度属布局约束）。

门禁：vitest 91 / tsc 零错误 / 零 Rust 改动。