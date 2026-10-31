# dsh-preset-manager

DSH（DeepSeek Harness）插件：把当前 profile 里的 **Agent preset** 列出来，并且能在**对话内**把正在进行的会话切到另一个 preset。

> 本仓前身是 `dsh-opencode-free`（星桥模式），那条线已废弃，见 [DISCARD.md](DISCARD.md)。

## 为什么需要它

DSH 自带的选择器只对「还没开始第一轮」的会话生效：`agentPresets.select()` 在会话已经跑过回合、或当前回合没关闭时会抛 `agent-preset/locked`（"This session has already started"）。结果是选完 preset 还得新开会话，长对话里换模式只能重开。

本插件走注册表另一条公开方法 `recompose()`——它 rebind 的是 agent 的 scope 父级，官方注释明确写着「空白会话检查由调用方负责」。再加上一条 `agent-preset/selected` 会话事件，切换就落在正在进行的会话上，从**下一步**开始生效。

## 能做什么

| 表面 | 用法 | 说明 |
|---|---|---|
| 斜杠命令 `/preset` | `/preset` | 列出全部 preset，标出「当前 / 新会话默认 / 加载失败」 |
| 斜杠命令 `/preset` | `/preset <id>` | 把当前会话切到 `<id>` |
| 工具 `preset_list` | 模型调用 | 同上的结构化版本（`id/name/description/order/broken/current/default`） |
| 工具 `preset_switch` | 模型调用 | 会话自行切换，返回 `{ changed, from, to }` |

命令在 Web 端由 composer 的 `/` 菜单提供，执行结果作为一条命令卡片留在对话流里；命令与结果都不会变成模型消息。

它**不创建、不删除** preset：preset 定义的持久形态是 bundle 补丁里的一行 `@deepseek-ai/dsh-agent-preset`，由 `plugin_manager` 或 profile 组合维护。本插件管理的是「选哪个」。

## 安装

```bash
# 从 GitHub 安装（装进哪个 profile 就传给 --profile）
dsh plugin --profile web add github:SZYTree0312/dsh-preset-manager
```

安装后需重启应用：bundle 行在启动时按 `dsh.profile.bundles` 组合。

本地开发用 `link:` 安装时注意 Windows 需要符号链接权限（开发者模式或管理员）：

```bash
dsh plugin --profile web add link:D:\Github_repo\dsh-opencode-free
```

拿不到符号链接权限时，可以手工放置：把包目录复制到 `<profile>/node_modules/dsh-preset-manager`，再把 `dsh-preset-manager` 加进该 profile `package.json` 的 `dsh.profile.bundles`。

## 配置

`cordis.patch.yml` 里的行配置（覆盖时是整块替换，三个键都要重述）：

```yaml
- id: dsh-preset-manager
  name: 'dsh-preset-manager'
  config:
    command: preset        # 命令名，必须匹配 /^[a-z][a-z0-9_-]*$/
    tools: true            # 是否注册 preset_list / preset_switch
    allowWhileBusy: false  # 回合还在跑时是否允许用 /preset 切换
```

`allowWhileBusy` 只管**命令**路径。工具调用天然发生在回合内部，切换总是被接受——下一步就会用新组合。

## 机制

1. agent loop 每个 step 都重新组装：`preStep()` → `systemPrompt.assemble(...)`，prompt sections 与工具 schema 都按「实时 scope 链」解析，没有按会话缓存的组合。
2. `agentPresets.recompose(agent.ctx, id)` → `mount()` → `bind()`；对已绑定的 agent 走 `binding.parent.rebind(generation.key)`，改的是 scope 父级映射。
3. 下一步组装顺着新映射读代际，于是拿到新 preset 的 prompt 段与工具集。
4. 本插件随后追加一条 `agent-preset/selected`（复用注册表自己的事件类型），会话恢复与 UI 标签都以它为准。

## 代价与风险（请先读）

- **前缀缓存归零**：换 preset 等于换 system prompt，下一轮请求的前缀复用会失去。别来回切。
- **旧代际不回收**：`bind()` 不会 retire 旧 generation（官方空白会话切换走同一路径），旧 preset 的插件效果会继续跑到进程退出；只有它的层条目退出了 scope 链。
- **历史只追加**：模型看到的是新 system message 与 `tool-addition` / `tool-removal` 的变更记录，而不是被重写的 prompt。
- **用的是 `recompose()` 这条路径**，不是产品层的 `select()`。上游若改它的语义（例如自己加上空白会话检查），本插件必须跟着改。
- **工具面会变**：切走后原 preset 的工具不再可见；若在回合中途切走，该回合下一步就缺这些工具。
- **不是安全边界**：preset 本身就能挂任意 Host 代码，能改 preset 选择的人本来就有同等能力。

## 验证情况

在本机（DSH 0.2.1-rc.5，Windows）实际跑过的：

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check index.js` | 退出码 0 |
| 单元测试 | `node test/plugin.test.mjs` | 15 项全过，退出码 0 |
| 组合 | 临时 `DSH_HOME` 里装包后 `dsh --profile pm --dump-config` | 退出码 0，输出含 `# == dsh-preset-manager` 与 `- id: dsh-preset-manager` |
| 激活 | `dsh --profile pm --port 5199 --no-open` | 正常启动并打印 URL，无 `entry did not activate` 警告 |
| 注册路径反证 | 故意把命令名改成 `BAD NAME`、让工具缺 `output` | loader 报 `1 entry did not activate`，报错来自 `dsh-commands` / `dsh-tools`，说明 `apply()` 里两处注册确实打到真实服务 |

**未验证**：真实模型轮次里「切换后下一步确实换了 prompt 与工具」的端到端效果（隔离环境没有可用模型凭据），以及 Web UI 里 `/preset` 的渲染与 preset 标签刷新。这两项需要你在装了凭据的 profile 里手工确认。

注：`node --test test/` 在这种受限 Windows 沙箱里会因 `spawn EPERM` 失败，直接 `node test/plugin.test.mjs` 即可（`npm test` 就是这么写的）。

## 兼容

- 基线：DSH `0.2.1-rc.5`。
- 声明注入 `agentPresets`、`commands`、`tools`；缺任一服务插件不会激活（避免半加载）。
- 无运行时 import：不引用任何 `@deepseek-ai/*` 包，工具与命令都用普通对象注册。

## 许可证

MIT