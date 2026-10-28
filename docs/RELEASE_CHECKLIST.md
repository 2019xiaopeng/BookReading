# v2.0.0 发布操作清单

CI 事实（已核对 `.github/workflows/windows-installers.yml`）：

- 触发条件是 **push 到 main 分支** 或 **手动 workflow_dispatch**，**不是** tag 触发。tag 仅用作 Release 锚点，不驱动构建。
- CI 产出 NSIS 安装包后压缩为 `bookreading_<sha>_windows.zip` 上传（超 95MB 会自动切成 `.part000/.part001…` 分卷），同时发布到预发布版 **Windows Latest**（tag `windows-latest`）和 `artifacts/windows-installers` 分支。

---

## 一、发布前确认

- [ ] 版本号四处一致为 2.0.0：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`

```bash
grep '"version"' package.json src-tauri/tauri.conf.json
grep -m1 '^version' src-tauri/Cargo.toml
grep -A1 '^name = "bookreading"' src-tauri/Cargo.lock | grep version
```

- [ ] 本地门禁全绿

```bash
npm test
npm run build
cd src-tauri && cargo test && cargo check
```

- [ ] `docs/CHANGELOG.md`、`docs/RELEASE_NOTES_v2.0.0.md`、`README.md` 内容与最终功能一致

## 二、提交并触发 CI

- [ ] 提交版本号与文档改动（含 Co-Authored-By 行）

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json README.md docs/CHANGELOG.md docs/RELEASE_NOTES_v2.0.0.md docs/RELEASE_CHECKLIST.md
git commit -m "release: v2.0.0"
git push origin main
```

- [ ] 确认 Actions 触发（push 到 main 自动触发；若未触发可手动）

```bash
gh run list --workflow windows-installers.yml --limit 3
gh workflow run windows-installers.yml   # 手动触发（备用）
gh run watch                             # 跟踪构建（约 15-25 分钟）
```

## 三、取得安装包

- [ ] 方式 A（推荐）：从 Windows Latest 预发布版下载 zip，解压出 `bookreading_2.0.0_x64-setup.exe`

```bash
gh release download windows-latest --repo <OWNER>/bookreading --pattern 'bookreading_*_windows.zip*' --dir release-tmp
# 若是分卷（.part000/.part001…），按序合并后再解压：
cat release-tmp/bookreading_*_windows.zip.part* > release-tmp/full.zip
cd release-tmp && unzip full.zip && cd ..
```

- [ ] 方式 B（备用）：本地构建直取 exe

```bash
CARGO_TARGET_DIR=D:/cargo-target/bookreading npm run tauri build
# 产物：src-tauri/target/release/bundle/nsis/bookreading_2.0.0_x64-setup.exe
```

- [ ] 安装冒烟：导入 EPUB / TXT / 漫画文件夹 / PDF 各一本，翻页、主题切换、回收站恢复、设置页版本号显示 2.0.0

## 四、打 tag 并创建正式 Release

- [ ] 对已推送的发布提交打 tag（tag 不触发 CI，仅作 Release 锚点）

```bash
git tag -a v2.0.0 -m "BookReading v2.0.0"
git push origin v2.0.0
```

- [ ] 创建 GitHub Release，正文用 RELEASE_NOTES_v2.0.0.md，附安装包

```bash
gh release create v2.0.0 \
  release-tmp/bookreading_2.0.0_x64-setup.exe \
  --title "BookReading v2.0.0" \
  --notes-file docs/RELEASE_NOTES_v2.0.0.md \
  --latest
```

- [ ] 核对 Release 页：标题、正文渲染、exe 可下载、标记为 Latest（Windows Latest 预发布版不抢 latest 位）

## 五、收尾

- [ ] README 顶部安装链接指向 `releases/latest`（已写好则核对一次）；如需徽章，加 `[![Release](https://img.shields.io/github/v/release/<OWNER>/bookreading)](../../releases/latest)`
- [ ] 通知渠道：发布说明、截图、升级指引（旧 group 自动转书架 / AppData 位置不变）
- [ ] 清理本地临时目录 `rm -rf release-tmp`
- [ ] 回顾：若 CI 触发方式或产物路径后续调整，同步更新本清单
