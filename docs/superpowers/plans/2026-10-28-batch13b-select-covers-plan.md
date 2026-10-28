# 2026-10-28 批次13b · 状态下拉统一与封面管线 — 变更记录

StatusFilterMenu：原生 select 换自定义下拉（复用 TagFilterMenu 结构与 wr-tag-pop 样式，单选即关，menuitemradio/aria-checked），与"标签/管理标签"控件语言完全统一；.wr-select 保留（另 6 处使用，深色修复仍必要）。
存量封面重提取：reextract_all_covers 命令（epub 全量重跑 13a 选最大图、覆盖写+清残留、跳过漫画/缺失、file_size/title 不动，Rust 测试：小cover+大图→取大图）；设置→存储新增"重新提取全部封面"（confirm 警示会覆盖手动封面），完成后失效全部封面缓存+广播刷新+报告 N 本。
显示端缩略：planCoverDownscale 纯函数（逐级减半至 512）+ downscaleCoverUrl（双 canvas 交替、high 平滑、jpeg 0.92），大源图步进降采样替代浏览器单次大比例缩放；任何失败回退原图 URL（回归证明：node 环境全走回退，既有测试原样过）。

门禁：vitest 125 / cargo test 76 / tsc 零错误。
已知：重提取会覆盖手动设置的同 path 封面（confirm 已警示，无撤销）；弹层项 focus-visible 与 TagFilterMenu 同为既有缺口。