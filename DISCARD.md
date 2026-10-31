# 已废弃：星桥模式（dsh-opencode-free）

```
状态：discard    决定日期：2026-11-01
```

## 结论

本目录原来承载的 **星桥模式** preset（包名 `dsh-opencode-free`，源自 OpenCode 风格的 bridge 组合）停止开发，不再维护，也不再发布。

## 被废弃的内容

- `presets/opencode-free.patch.yml` —— 星桥模式的 preset 组合
- `docs/how-the-bridge-shapes-the-request.md` —— 该组合如何改写请求的说明
- 旧 `README.md`（星桥模式的介绍与安装说明）

旧实现只保留在 git 历史里，最后一次提交为 `50ed5c1`（重命名 `opencode-zen` → `opencode-free` 之后的那次）。

## 处置记录

| 项 | 状态 |
|---|---|
| 本机 DSH desktop profile 里的 `dsh-opencode-free` | 已卸载（2026-11-01，`dsh plugin --profile desktop remove dsh-opencode-free`，退出码 0；`dsh.profile.bundles` 与 `dependencies` 均已移除） |
| GitHub 仓库 `SZYTree0312/dsh-opencode-free` | 待删除（需要带 `delete_repo` 权限的 `gh` 登录，本机当前 `gh` 未登录） |
| 本目录 | 改为承载 `dsh-preset-manager` |

## 现在这里是什么

`dsh-preset-manager`：在对话内列出并切换 Agent preset 的 DSH 插件。见 [README.md](README.md)。