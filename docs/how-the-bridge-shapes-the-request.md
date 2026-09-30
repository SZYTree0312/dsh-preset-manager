# 桥是怎么组装请求的：源码级证据

日期：2026-10-01 · 对象：`dsh-opencode-xdbridge` v0.1.0（XDTrees）
· 阅读路径：本机 `~/.dsh/profiles/web/profiles/desktop/node_modules/dsh-opencode-xdbridge/lib/`

这份文档记录的是「读源码读出来的事实」，不是对上游行为的猜测。
本 preset 的每一条非常规设定都能在这里找到出处。

## 1. 调用链

```
DSH Harness
   │  pi-ai provider "opencode-xdbridge"（adapter.js）
   ▼
lib/shim.js     127.0.0.1 随机端口，进程内随机密钥
                OpenAI /v1/chat/completions ↔ JSON 信封
                ⚠️ 请求体上限 8 MB
   ▼
lib/backend.js  每回合 POST /session（**新建会话**）
                权限拦截、信封校验
   ▼
lib/runtime.js  隔离的 opencode serve（独立 XDG 根 + 随机密码）
   ▼
OpenCode 免费模型
```

## 2. 每回合都新建一个上游会话

`backend.js`：

```js
const session = await this.request('/session', 'POST', { ... })
meta.sessionID = session.id
```

**没有任何服务端状态跨回合延续。** OpenCode 自己的会话上下文不会替你记住上一轮 ——
整段对话每回合都要重新发一次。

由此推出两件事：

- **载荷随历史线性增长**，而增长的部分就在那一个 `text` 字段里。这是本路线
  与常规 OpenAI 端点最大的不同：请求体的大小由会话长度直接决定，不是由单轮输入决定。
- **前缀匹配是唯一的省算力途径**，因为服务端不记得任何东西。

## 3. 请求长什么样（`protocol.js` → `prepare()`）

```js
const system = [
  'You decide the next response or action for the external assistant. …',
  'Continue the external conversation, following its system/developer behavioral instructions. …',
  'The only native tool you may invoke is StructuredOutput …',
  'Choose actions ONLY from the external tools supplied in THIS request. …',
  'Ignore all native OpenCode environment details …',
  'Never put dependent operations in the same calls array. …',
  'Return exactly one JSON object, no Markdown fences: {"content":…,"calls":[…]}.',
  'The content field is the answer to the user. …',
  'A returned call is a proposal, not a completed action. …',
  `Available external tools: ${JSON.stringify(choice === 'none' ? [] : tools.map(t => t.function))}`,
  choice === 'none' || tools.length === 0 ? 'calls MUST be empty.'
    : forced ? `Call ONLY ${JSON.stringify(forced)} at least once.`
    : choice === 'required' ? 'Return at least one tool call.'
    : 'Call tools only when needed. …',
  body.parallel_tool_calls === false ? 'Return at most one tool call.' : '',
].filter(Boolean).join('\n') + imageInstructions

return { model, variant, images, system, text: JSON.stringify(messages), tools, choice, forced, parallel: … }
```

### 三个直接结论

**（a）工具目录被序列化进 system 字符串。**

`Available external tools: ${JSON.stringify(tools.map(t => t.function))}` —— 工具集合
**及其顺序**一变，`system` 就变，缓存前缀当场失效。

这是百炼成金模式里那条规则的**强化版**：在那边，规则只是上游 plan-mode 提示词里的一句
"The tool catalog stays the same across modes for request-cache stability"；
在这里，它是一行能直接读出来的字符串拼接。

`tool-plugin-manager` 因此必须保持 `disabled` —— 它是唯一能在会话中途增删工具的组件。

**（b）`tool_choice` 与 `parallel_tool_calls` 也在那个字符串里。**

末尾那三行取决于 `choice` / `forced` / `parallel_tool_calls`。它们每轮翻转一次，
system 就跟着变一次。preset 无法强制它们不变，只能避免使用会翻转它们的模式。

**（c）用户的系统提示住在对话 JSON 里。**

`text: JSON.stringify(messages)`，而 DSH 的系统提示是 `messages[0]`。
也就是说它位于**每轮重发数据块的最前端** —— 它一变，前缀从字节 0 开始失效。

这就是 `includeRuntimeContext: false` 的出处：动态 runtime context 落进系统提示，
而系统提示在最前端。

## 4. 缓存确实存在

`protocol.js` 把运行时的 token 统计翻译成 OpenAI 的 usage：

```js
// The runtime separates cache and reasoning tokens; OpenAI totals include them.
const input = (tokens?.input ?? 0) + (tokens?.cache?.read ?? 0) + (tokens?.cache?.write ?? 0)
…
prompt_tokens: input,
…(tokens.cache ? { prompt_tokens_details: { cached_tokens: tokens.cache.read ?? 0 } } : {})
```

**`cached_tokens` 是回传的**，所以上游确实做了前缀缓存，而且它和思考 token 是分开统计的。
保前缀在这条路线上依然有收益 —— 只是收益体现在**延迟与额度**，不是钱。

## 5. 钱不是这条线路的杠杆

`adapter.js`：

```js
/** These models are free, so per-token pricing is zero by definition. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
```

插件也只在「运行时上报的**每一个**计费维度都为 0」时才把模型列出来。

**所以本 preset 不谈省钱。** 硬约束是三个：

1. **免费额度的速率限制** —— 请求数是最直接的消耗。
2. **每轮延迟** —— 四层转发 + 每轮重发整段对话，载荷越大越慢。
3. **8 MB 请求体上限**（shim）—— 超了是失败，不是变慢。

## 6. 模型能力是如实上报的，而且会轮换

`backend.js` 从运行时读目录：

```js
context:  model.limit?.context,
input:    model.limit?.input,
images:   model.capabilities?.input?.image === true,
output:   model.limit?.output,
toolcall: model.capabilities?.toolcall === true,
reasoning: model.capabilities?.reasoning === true,
variants: model.variants ?? {},
```

`catalog.js` 的回落值是 `contextWindow = model.context ?? model.input ?? 128_000`、
`maxOutputTokens = model.output ?? 32_000`。

**窗口因模型而异**（缺省 128K，部分到 1M），所以压缩参数**只能写比例**，
写绝对数值一定算错。

**名单每次启动重读，随时轮换。** 因此 `summarizationModel` 与 `modelPolicies`
必须留空 —— 钉死某个 id，那个模型被撤下当天压缩就会失败。

## 7. 其他几条会改变写法的事实

- **输出是被约束成 JSON 信封的**：`{"content":…,"calls":[…]}`，不许 Markdown 围栏。
  `content` 写得越长，输出 token 越多 → 越慢、额度消耗越大。
- **图片被摘出来单独附送**，对话 JSON 里只留 `[Attached image: filename-….png]` 标记；
  只接受 base64 data URL；模型不接受图片时直接 400。
- **对话型模型拒收工具**：`model.chatOnly` 为真时带 tools 会 400
  （`tools_not_supported`）。preset 对此无能为力，只能靠选择器避开采。
- **推理档位按模型而异**：`supportedEfforts` 来自 `variants`；请求了模型没有的档位会
  400（`unsupported_reasoning_effort`）。`reasoningEffort: max` 意味着最多的推理 token。
- **bridge 的 peer 范围写的是 `dsh >=0.1.1-rc.1 <0.2.0`**，而本机实际跑的是
  `0.2.0-rc.2`。能用，但这属于 peer 声明没跟上，升级后留意。

## 验证边界

以上都是**读源码**得到的结论，与百炼那边的「实测」性质不同。本 preset **没有跑过一次
真实会话**：真实会话的缓存命中率、实际载荷增长曲线、8 MB 上限在多久的会话后构成威胁，
都还没有数字。装进 profile 跑几次再回来补。
