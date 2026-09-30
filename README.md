# 星桥模式（opencode-free）

挂在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）上的
agent preset，为 **OpenCode 的免费模型**这条路线做前缀稳定与载荷控制。
不是独立运行时、不是 fork。

前置依赖：社区插件 [`dsh-opencode-xdbridge`](https://github.com/XDTrees/dsh-opencode-xdbridge)
（XDTrees）。它把 OpenCode 的免费模型通过隔离的 opencode 运行时接进 dsh，
注册成 provider `opencode-xdbridge`。**本 preset 只做 agent 侧的行为策略，不替代那个插件。**

上游基线：`0.2.0-rc.2`（必须 pin，上游明示会有破坏性变更）。

名字从「星」与「桥」：星是那批免费模型（space-bunny、big-pickle…），
桥是 xdbridge 这座桥。

> **为什么 id 是 `opencode-free` 而不是 `opencode-zen`：**
> Zen 是对方的**订阅套餐**名，拿别人的产品名当自己 preset 的名字不合适。
> 这里的 `free` 指的是走的免费额度路线，与套餐无关 —— 本 preset 也不要求你订阅任何东西。

## 最重要的一件事：这条路线不省钱

`dsh-opencode-xdbridge` 在 `adapter.js` 里硬编码：

```js
/** These models are free, so per-token pricing is zero by definition. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
```

插件也只在运行时上报的**每一个**计费维度都为 0 时才把模型列出来。

**所以「省 token」在这里不是目标。** 真正的硬约束是三个：

| 约束 | 表现 | preset 怎么应对 |
|---|---|---|
| 免费额度的**速率限制** | 请求数是最直接的消耗 | 推动并行调用、少绕弯、压缩尽量不触发（一次摘要 = 一次额外请求）|
| 每轮**延迟** | 四层转发，且整段对话每轮重发 | 控制载荷增长，保住缓存前缀 |
| shim 的 **8 MB 请求体上限** | 超了是**失败**，不是变慢 | 收紧 `tool-fs` 读上限、收紧裁剪阈值、长输出重定向到文件 |

## 一句话原理

这条路线**每回合新建一个上游会话**（`backend.js` 里 `POST /session`），
服务端不保留任何状态 —— 整段对话每回合都要重新发一次。

于是：

1. **载荷随历史线性增长**，请求体大小由会话长度决定，而不是单轮输入。
2. **前缀匹配是唯一的省算力途径**，而且它确实存在（bridge 会把
   `cached_tokens` 回传成 `prompt_tokens_details.cached_tokens`）。
3. **收益落在延迟与额度上，不是钱。**

## 工具目录为什么必须全程固定

百炼成金模式里，这条规则来自上游 plan-mode 提示词里的一句话。
**在这里它是可以读出来的字符串拼接** —— `protocol.js` 组装 system 时：

```js
`Available external tools: ${JSON.stringify(choice === 'none' ? [] : tools.map(t => t.function))}`
```

工具集合**或顺序**一变，`system` 就变，缓存前缀当场失效。
所以 `tool-plugin-manager` 必须保持 `disabled` —— 它是唯一能中途增删工具的组件。

同一段代码还意味着：`tool_choice` 与 `parallel_tool_calls` 也会改变 system 的
末尾几行，所以应当避免那些会让它们逐轮翻转的模式。

完整证据见 [`docs/how-the-bridge-shapes-the-request.md`](docs/how-the-bridge-shapes-the-request.md)。

## 与百炼成金模式的差异

两者形态相同（一个 `@deepseek-ai/dsh-agent-preset` 声明），但**目标函数不同**，
所以同一批旋钮拧的方向也不同：

| 旋钮 | 百炼成金（省钱）| 星桥（省额度/延迟/载荷）| 为什么反着来 |
|---|---|---|---|
| `agent-instructions.maxBytes` | 131072（比上游 65536 加倍）| **32768**（比上游减半）| 那边常驻内容吃缓存价，便宜；这里每字节都在每轮重发的数据块里 |
| `tool-result-pruner` | 8192/4096/1024（上游默认）| **4096/2048/512** | 这里多一条硬闸：8 MB 请求体上限 |
| `compaction.headroomTokens` | 不动（65536）| **32768** | 免费模型窗口常只有 128K，65536 的余量会把触发点压到 30464 |
| `summarizationModel` | 钉 `qwen3.8-flash` | **留空** | 免费名单随时轮换，钉死 id 会在模型撤下那天让压缩失败 |
| `modelPolicies` | 按模型覆盖 | **留空** | 同上，按 id 精确覆盖是定时炸弹 |
| `tool-fs` 读上限 | 不设 | **收紧到 800 行 / 1000 字符 / 24 KiB** | 这里载荷是真金白银的约束 |

相同的是三条核心纪律：工具目录全程固定、历史只追加、动态状态推尾部。

## 目录

```
presets/opencode-free.patch.yml            preset 定义，主产物
docs/how-the-bridge-shapes-the-request.md 源码级证据：桥怎么组装请求
```

## 接入

### 本 preset 不含 xdbridge，也不会替你装它

两个包是**分开的**，各有各的作者：

| 部分 | 层级 | 作者 | 管什么 |
|---|---|---|---|
| `dsh-opencode-xdbridge` | Host（provider）| XDTrees | provider 注册、模型目录、隔离运行时、8 MB 上限 |
| 本 preset（`dsh-opencode-free`）| Agent | 本仓库 | 工具面、提示词、压缩策略、载荷控制 |

**为什么不打包进去：**

1. **不替别人分发代码。** 那是 XDTrees 的项目，MIT 也不该由我这边再发一份。
2. **打包就等于钉死版本。** 桥接插件依赖 OpenCode 的客户端接口（不是官方开放 API），
   OpenCode 一更新它就可能要跟着改。装成独立插件，更新由上游直接推给你；
   打进本仓库，就得等我发新版 —— 那才是真的跟不上。
3. **写进 patch 会出事。** 在 `presets/opencode-free.patch.yml` 里加一行
   `- id: llm-opencode-xdbridge` 去注册 provider，等于引用一个可能没安装的包，
   加载期直接失败，可能连累整个 profile。**别这么干。**

**反过来也是安全的：** 本 preset 的 YAML 里**没有一行引用 `opencode-xdbridge`**
（全文件搜 `opencode` 只出现在注释、preset id 和描述里，插件 `name:` 全是
`@deepseek-ai/*`）。所以：

- 没装桥接插件也能装本 preset —— 只是选不到那些模型，不会报错、不会拖垮 profile。
- 本 preset 的调参思路（载荷要小、前缀要稳、压缩要晚）对任何「按上下文线性付费、
  且每轮重发整段对话」的路线都成立，换 provider 也能用，只是数值要重新看。

### ⚠️ 本 preset 的结论会随桥的实现变化

上面每一条非常规设定都对应 `dsh-opencode-xdbridge` **v0.1.0 源码里的具体一行**
（见 [`docs/how-the-bridge-shapes-the-request.md`](docs/how-the-bridge-shapes-the-request.md)）。
如果上游改了任意一处，对应的设定就该重新看：

| 若上游改了 | 需要复查 |
|---|---|
| `protocol.js` 的 system 组装（尤其工具目录那段）| 「工具目录必须固定」这条还在不在 |
| `backend.js` 的会话策略（不再每回合新建）| 载荷是否还线性增长、8 MB 上限还构不构成威胁 |
| `adapter.js` 的 `NO_COST` / 窗口上报 | 压缩参数与 `modelPolicies` 留空的理由 |
| shim 的请求体上限 | `tool-fs` 读上限与裁剪阈值的激进程度 |

### 安装

先装插件（上游的）：

```bash
dsh plugin --profile web add github:XDTrees/dsh-opencode-xdbridge
```

再装本 preset：

```bash
dsh plugin --profile web add github:SZYTree0312/dsh-opencode-free
```

装完后在会话预设选择器里选 **星桥模式**。卸载：

```bash
dsh plugin --profile web remove dsh-opencode-free
```

> 插件的 peer 范围写的是 `dsh >=0.1.1-rc.1 <0.2.0`，而本 preset 按 `0.2.0-rc.2`
> 的 preset 机制写。**本机两者并存且可用**，但那是 peer 声明没跟上，升级后留意。

## 撞限流时的调整顺序

从最有效到最伤能力：

1. 关网页抓取：`tool-web` 的 `fetch: false`（搜索保留）
2. 关子代理与 workflow：`tool-subagent` / `tool-subagent-fork` / `workflow-ptc` /
   `tool-workflow` 置 `disabled: true` —— 它们成倍增加请求数
3. 再压 `tool-fs` 的读上限（500 行 / 800 字符 / 16 KiB）
4. 降推理档位：profile 里 `agent-default-model.reasoningEffort` 从 `max` 往下调
   —— 推理 token 是按输出算的，`max` 意味着最多

`readLimit` 这类上限收得太狠会逼模型分块重读，反而多花回合。
**先跑几次真实会话看会不会明显多出重读，再决定。**

## 状态

- [x] 源码级验证：桥的请求装配方式、缓存回传、每回合新建会话、8 MB 上限
      （见 `docs/how-the-bridge-shapes-the-request.md`）
- [x] preset 第一版
- [ ] **实机验证：装进 profile 跑一次完整会话** —— 命中率、载荷增长曲线、
      8 MB 上限在多久的会话后构成威胁，都还没有数字
- [ ] 各免费模型的实际窗口/输出上限核对（目录每次启动重读，随时可能变）

> **尚未实机验证。** 本 preset 的结论全部来自读 `dsh-opencode-xdbridge` 的源码
> 与 README，与百炼那边的「实测」性质不同。装进 profile 跑几次再回来补数字。
