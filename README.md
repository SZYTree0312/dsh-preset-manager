# dsh-preset-manager

DSH（DeepSeek Harness）插件：把当前 profile 里的 **Agent preset** 列出来，并且能在**对话内**把正在进行的会话切到另一个 preset。

> 本仓前身是 `dsh-opencode-free`（星桥模式 preset），那条线已废弃、原仓库已删除；旧实现只留在 git 历史里（最后一次提交 `50ed5c1`）。

## 为什么需要它

DSH 自带的选择器只对「还没开始第一轮」的会话生效：`agentPresets.select()` 在会话已经跑过回合、或当前回合没关闭时会抛 `agent-preset/locked`（"This session has already started"）。结果是选完 preset 还得新开会话，长对话里换模式只能重开。

本插件走注册表另一条公开方法 `recompose()`——它 rebind 的是 agent 的 scope 父级，官方注释明确写着「空白会话检查由调用方负责」。再加上一条 `agent-preset/selected` 会话事件，切换就落在正在进行的会话上，从**下一步**开始生效。

## 能做什么

**会话头部的按钮与菜单**（0.1.8 起）：标题栏上多一个显示当前 preset 名的按钮，点开是全部 preset 的列表，每行两个动作：

- **切换** —— 真换组合：prompt 与工具集都按目标 preset 重新组装，下一步生效；请求前缀变了，缓存从头算。
- **柔切** —— 保留当前 prompt、工具集与**前缀缓存**：不 rebind，只把目标 preset 声明的人设文本作为一条消息追加到历史里，模型从下一步起按它工作。

菜单里当前 preset 带「当前」标记，执行结果（成功文本或拒绝原因）直接显示在菜单底部。

命令行与工具是同一套能力的另外两个入口：

| 表面 | 用法 | 说明 |
|---|---|---|
| `/preset` | 无参数 | 列出全部 preset，标出「当前 / 新会话默认 / 加载失败」 |
| `/preset <id>` | 硬切换 | 把当前会话切到 `<id>` |
| `/preset soft <id>` | 柔切 | 追加人设文本，prompt 与缓存不动 |
| `/preset diff <id>` | 预检 | 打印两个 preset 声明的行差异，并给出「缓存是否安全」的结论 |
| 工具 `preset_list` | 模型调用 | 结构化名单（`id/name/description/order/broken/current/default`） |
| 工具 `preset_switch` | 模型调用 | `{ preset, mode: "hard" \| "soft" }`，返回 `{ changed, mode, from?, to, note? }` |
| 工具 `preset_diff` | 模型调用 | 返回 `{ from?, to, cacheSafe, added, removed, changed }` |

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

硬切换（`/preset <id>`、菜单里的「切换」、`preset_switch` 默认 mode）：

1. agent loop 每个 step 都重新组装：`preStep()` → `systemPrompt.assemble(...)`，prompt sections 与工具 schema 都按「实时 scope 链」解析，没有按会话缓存的组合。
2. `agentPresets.recompose(agent.ctx, id)` → `mount()` → `bind()`；对已绑定的 agent 走 `binding.parent.rebind(generation.key)`，改的是 scope 父级映射。
3. 下一步组装顺着新映射读代际，于是拿到新 preset 的 prompt 段与工具集。
4. 本插件随后追加一条 `agent-preset/selected`（复用注册表自己的事件类型），会话恢复与 UI 标签都以它为准。

柔切（`/preset soft <id>`、菜单里的「柔切」、`preset_switch mode:"soft"`）：

1. 用 `agentPresets.readDocument(id)` 拿到目标 preset 的声明（Loader 自己 dump 出来的 YAML）。
2. 从声明里取出 `@deepseek-ai/dsh-persona` 行的 `prefix` / `suffix` 文本块。
3. 拼成一条说明，`agent.inject(createUserMessage(...))` 追加进 inbox —— 它在下一次被承认的 step 进入历史。
4. **不 rebind**：scope 链没动，system prompt 与工具 schema 逐字节不变，请求前缀完全一致，缓存照旧命中；变化的只有历史尾部的那一条消息。

柔切是近似，不是等价：工具集仍是当前 preset 的（鲸英模式的 `str_replace_editor`、更晚的压缩这些拿不到），而且那条说明会作为一条用户消息留在对话里 —— 这正是它保留缓存的方式。用 `diff <id>` 先看清差异再决定。

## 代价与风险（请先读）

- **硬切换＝前缀缓存归零**：换 preset 等于换 system prompt 与工具表，下一轮请求的前缀复用会失去。要缓存就只能柔切，或者干脆别切。
- **旧代际不回收**：`bind()` 不会 retire 旧 generation（官方空白会话切换走同一路径），旧 preset 的插件效果会继续跑到进程退出；只有它的层条目退出了 scope 链。
- **历史只追加**：模型看到的是新 system message 与 `tool-addition` / `tool-removal` 的变更记录，而不是被重写的 prompt。
- **用的是 `recompose()` 这条路径**，不是产品层的 `select()`。上游若改它的语义（例如自己加上空白会话检查），本插件必须跟着改。
- **工具面会变**：切走后原 preset 的工具不再可见；若在回合中途切走，该回合下一步就缺这些工具。
- **柔切解析的是声明文本**：只认 `@deepseek-ai/dsh-persona` 的 `prefix`/`suffix` 块；preset 若用别的插件改 prompt，柔切会明确报「没有声明可注入的 prompt 文本」而不是假装成功。
- **不是安全边界**：preset 本身就能挂任意 Host 代码，能改 preset 选择的人本来就有同等能力。

## 验证情况

在本机（DSH 0.2.1-rc.5，Windows）实际跑过的：

| 检查 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check index.js && node --check client.js` | 退出码 0 |
| 单元测试 | `node test/plugin.test.mjs` | 23 项全过，退出码 0 |
| 组合 | 临时 `DSH_HOME` 里装包后 `dsh --profile pm --dump-config` | 退出码 0，输出含 `# == dsh-preset-manager` 与 `- id: dsh-preset-manager` |
| 激活 | `dsh --profile pm --port 5199 --no-open` | 正常启动并打印 URL，无 `entry did not activate` 警告 |
| 前端被识别 | 同一实例的启动页 | 模块清单里出现 `{"id":"dsh-preset-manager","url":"plugins/??dsh-preset-manager/client.js&rev=…","immediately":true}` |
| 前端被下发 | 带 auth cookie 取 `plugins/??dsh-preset-manager/client.js&rev=…` | HTTP 200、13568 字节，内容含 `dpm-trigger`、`conversation.session.header.actions`、`agentPresets`、`commands.execute` |
| 注册路径反证 | 故意把命令名改成 `BAD NAME`、让工具缺 `output` | loader 报 `1 entry did not activate`，报错来自 `dsh-commands` / `dsh-tools`，说明 `apply()` 里的注册确实打到真实服务 |

**未验证**：真实浏览器里点一次菜单（我只能证明模块被 Host 发现、正确下发、内容正确，没有浏览器可点）；真实模型轮次里「硬切换后下一步确实换了 prompt 与工具」以及「柔切后模型确实照做」的端到端效果（隔离环境没有模型凭据）。这几项要你在装了凭据的 profile 里手工确认。

注：`node --test test/` 在这种受限 Windows 沙箱里会因 `spawn EPERM` 失败，直接 `node test/plugin.test.mjs` 即可（`npm test` 就是这么写的）。

## 兼容

- 基线：DSH `0.2.1-rc.5`。
- Host 半边声明注入 `agentPresets`、`commands`、`tools`；缺任一服务插件不会激活（避免半加载）。
- 前端半边走 `dsh.client`（`platform: web`、`immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-conversation"]`），只从浏览器模块表取 `react`，不 require 任何 `@deepseek-ai/*` 包。
- 界面文字按 `navigator.language` 选中文/英文，没有接 Client 的 locale 服务（0.1.8 的已知限制）。
- 用到的 Remote：`agentPresets.list`（读名单）、`commands.execute`（执行 `/preset …`）。

## 许可证

MIT