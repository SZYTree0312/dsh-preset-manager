/**
 * dsh-preset-manager — Host half.
 *
 * Adds an in-conversation preset switcher beside `@deepseek-ai/dsh-agent-preset-registry`:
 *
 * - `/preset` (name configurable) lists the presets and switches this
 *   conversation to another one; the command runs against the agent and never
 *   becomes a model message.
 * - `preset_list` / `preset_switch` expose the same surface to the model, so a
 *   session can also switch itself.
 *
 * The stock registry accepts a preset change only for a session that has not
 * started a turn: `select()` refuses with `agent-preset/locked` once
 * `turnBoundary.lastTurn > 0` or a turn is open. This plugin instead calls
 * `recompose(ctx, id)`, whose own contract leaves the blank-session policy to
 * the caller, then records the switch as an `agent-preset/selected` session
 * event. The agent loop assembles prompt sections and tool schemas from the
 * live scope chain on every step (`agent-loop` preStep), so the new preset
 * takes effect from the next step of the running conversation.
 *
 * Costs of a rebind, all inherited from the registry path:
 * - the next request starts a new prompt prefix, so prefix caching is lost;
 * - the previous preset generation stays mounted (its effects keep running)
 *   until the process exits, because `bind()` does not retire it;
 * - tool schemas that changed are logged as tool-addition/tool-removal, which
 *   the model sees as a change notice in an append-only history.
 *
 * No runtime imports: the plugin talks to the registry through the injected
 * `agentPresets` service and registers plain command/tool definitions, so it
 * resolves nothing from the dsh installation.
 *
 * @module dsh-preset-manager
 */

/** Loader row name for this plugin. */
export const name = 'dsh-preset-manager'

/**
 * `agentPresets` is the capability; `commands` and `tools` are the two
 * surfaces a profile needs for the plugin to be useful. Declaring all three
 * keeps a profile without them from half-loading the plugin and turns a
 * registration failure into a visible activation failure instead of a silent
 * child-fiber log line.
 */
export const inject = ['agentPresets', 'commands', 'tools']

/** Defaults for every option {@link apply} accepts. */
const DEFAULT_OPTIONS = Object.freeze({
  command: 'preset',
  tools: true,
  allowWhileBusy: false,
})

const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

const COMMAND_DESCRIPTION = '列出本 profile 的 Agent preset，把当前对话切换过去，或在不动 prompt 的前提下柔切'

const LIST_TOOL_DESCRIPTION = 'List the Agent presets installed in this Harness profile. '
  + 'Each row carries the exact id to pass to preset_switch, the display name, the declared order, '
  + 'and a `broken` diagnostic when the preset\'s plugins failed to load. '
  + '`current` is the preset this conversation runs; `default` is the one new sessions start with. '
  + 'Call this before preset_switch so the id is exact.'

const SWITCH_TOOL_DESCRIPTION = 'Switch this conversation to another Agent preset. '
  + 'mode "hard" (default) rebinds the composition, which changes the prompt, tools, and skills from the '
  + 'next step and starts a new prompt prefix, so provider prefix caching is lost. '
  + 'mode "soft" keeps the composition, the tool set, and the prefix cache, and appends the target '
  + 'preset\'s declared prompt text as one note instead; it is an approximation, not an equal switch. '
  + 'The switch is recorded in the session log and applies immediately: the current turn continues, '
  + 'and the next model step assembles the new composition. '
  + 'Use preset_list first for exact ids and preset_diff to see the cost; hard-switching to the current preset is a no-op.'

const DIFF_TOOL_DESCRIPTION = 'Compare a preset against the one this conversation runs, without switching. '
  + 'Reports the declared plugin rows that would be added, removed, or changed, and whether the request '
  + 'prefix would stay identical (cacheSafe). Use it before a hard switch to show the cost.'

/**
 * Validate the row config. The plugin declares no schemastery `Config` (which
 * would need an import), so the contract is enforced here, at load time.
 * @param config - raw `config` from the loader row; may be undefined.
 * @returns the normalized options.
 * @throws TypeError when a value has the wrong type or an unusable command name.
 */
function readOptions(config) {
  if (config === undefined || config === null) return { ...DEFAULT_OPTIONS }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('dsh-preset-manager: config must be an object')
  }
  const command = config.command === undefined ? DEFAULT_OPTIONS.command : config.command
  if (typeof command !== 'string' || !COMMAND_NAME.test(command)) {
    throw new TypeError(`dsh-preset-manager: config.command must match ${String(COMMAND_NAME)}`)
  }
  const tools = config.tools === undefined ? DEFAULT_OPTIONS.tools : config.tools
  if (typeof tools !== 'boolean') {
    throw new TypeError('dsh-preset-manager: config.tools must be a boolean')
  }
  const allowWhileBusy = config.allowWhileBusy === undefined
    ? DEFAULT_OPTIONS.allowWhileBusy
    : config.allowWhileBusy
  if (typeof allowWhileBusy !== 'boolean') {
    throw new TypeError('dsh-preset-manager: config.allowWhileBusy must be a boolean')
  }
  return { command, tools, allowWhileBusy }
}

/**
 * Read the preset a live agent is bound to.
 * @param registry - the `agentPresets` service.
 * @param agent - the calling agent.
 * @returns its preset id, or undefined when the composition has no preset.
 */
function currentPresetOf(registry, agent) {
  if (agent === undefined || agent === null) return undefined
  try {
    const id = registry.composedPreset(agent.ctx)
    return typeof id === 'string' ? id : undefined
  }
  catch {
    // A composition without a preset binding is a normal state, not a failure.
    return undefined
  }
}

/**
 * Read the registry's default preset for new sessions.
 * @param registry - the `agentPresets` service.
 * @returns the default id, or undefined when the build does not expose it.
 */
function defaultPresetOf(registry) {
  try {
    const id = registry.defaultId
    return typeof id === 'string' ? id : undefined
  }
  catch {
    // Older builds may not implement the getter; the listing stays usable.
    return undefined
  }
}

/**
 * Whether a turn is currently open on this session, i.e. a model step may be
 * assembling the composition right now.
 * @param ctx - the plugin context, for the optional session-projection service.
 * @param session - the session to inspect.
 * @returns true only when the projection positively reports an open turn.
 */
function turnIsOpen(ctx, session) {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined || typeof projections.stateOf !== 'function') return false
  try {
    const boundary = projections.stateOf(session, 'turnBoundary')
    return boundary !== undefined && boundary.openTurnStartSeq !== null
  }
  catch {
    // An unregistered projection key means this build cannot answer; do not
    // block the user on a missing signal.
    return false
  }
}

/**
 * Serialize switches per agent so two overlapping requests cannot interleave
 * `recompose()` calls on one scope.
 */
const switchQueues = new WeakMap()

/**
 * Rebind a live conversation to another preset.
 * @param ctx - the plugin context.
 * @param agent - the calling agent.
 * @param presetId - the requested preset id.
 * @returns `{ changed, from, to }`; `from` is absent when the agent had no preset.
 * @throws Error when the id is unknown, the preset failed to load, or the
 * registry does not expose the rebind path this build needs.
 */
async function switchPreset(ctx, agent, presetId) {
  if (agent === undefined || agent === null) {
    throw new Error('preset_switch requires an owning agent session')
  }
  const registry = ctx.agentPresets
  if (registry === undefined || typeof registry.recompose !== 'function') {
    throw new Error('this dsh build does not expose agentPresets.recompose()')
  }
  const roster = await registry.list()
  const target = roster.find((row) => row.id === presetId)
  if (target === undefined) {
    const available = roster.map((row) => row.id).join(', ')
    throw new Error(`未知 preset "${presetId}"；可用：${available}`)
  }
  if (typeof target.broken === 'string' && target.broken.length > 0) {
    throw new Error(`preset "${presetId}" 加载失败：${target.broken}`)
  }
  const previous = switchQueues.get(agent) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(async () => {
    // Read the live binding inside the queued task: an earlier queued switch
    // may already have moved this agent.
    const from = currentPresetOf(registry, agent)
    if (from === presetId) return { changed: false, from, to: presetId }
    await registry.recompose(agent.ctx, presetId)
    agent.session.append('agent-preset/selected', { agentPreset: presetId })
    return { changed: true, from, to: presetId }
  })
  switchQueues.set(agent, current)
  try {
    return await current
  }
  finally {
    if (switchQueues.get(agent) === current) switchQueues.delete(agent)
  }
}

/**
 * Render the preset roster as lines a user or the model can read.
 * @param roster - rows from `agentPresets.list()`.
 * @param current - the preset this conversation runs, when known.
 * @param fallback - the default for new sessions, when known.
 * @returns one line per preset, with marks in ASCII brackets.
 */
function formatRoster(roster, current, fallback) {
  const lines = roster.map((row) => {
    const marks = []
    if (row.id === current) marks.push('当前')
    if (row.id === fallback) marks.push('新会话默认')
    if (typeof row.broken === 'string' && row.broken.length > 0) marks.push('加载失败')
    const label = row.name === undefined ? row.id : `${row.name} (${row.id})`
    const detail = row.description === undefined ? '' : ` — ${row.description}`
    const mark = marks.length === 0 ? '' : ` [${marks.join(' / ')}]`
    return `- ${label}${mark}${detail}`
  })
  if (lines.length === 0) return '本 profile 没有注册任何 preset。'
  return lines.join('\n')
}

/**
 * Drive `/preset`: no input lists the roster, `<id>` rebinds, `soft <id>`
 * appends the preset's prompt text instead, `diff <id>` reports the cost.
 * @param ctx - the plugin context.
 * @param options - normalized plugin options.
 * @param invocation - the command invocation supplied by the registry.
 * @returns a settled command result.
 */
async function runCommand(ctx, options, invocation) {
  const registry = ctx.agentPresets
  const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
  try {
    const roster = await registry.list()
    const current = currentPresetOf(registry, invocation.agent)
    const fallback = defaultPresetOf(registry)
    const [head, ...rest] = raw === '' ? [] : raw.split(/\s+/u)
    if (head === undefined || head === 'list') {
      return { kind: 'success', text: formatRoster(roster, current, fallback) }
    }
    const known = (presetId) => {
      if (roster.some((row) => row.id === presetId)) return presetId
      throw new Error(`未知 preset "${presetId}"；可用：${roster.map((row) => row.id).join(', ')}`)
    }
    if (head === 'diff' || head === 'soft') {
      const [presetId] = rest
      if (presetId === undefined) return { kind: 'error', text: `用法：/${options.command} ${head} <preset id>` }
      known(presetId)
      if (turnIsOpen(ctx, invocation.agent?.session) && options.allowWhileBusy !== true) {
        return { kind: 'error', text: `当前回合还在运行，结束后再操作 "${presetId}"（或把 dsh-preset-manager 的 allowWhileBusy 设为 true）。` }
      }
      if (head === 'diff') {
        return { kind: 'success', text: formatDiff(await diffPresets(ctx, current, presetId, roster)) }
      }
      const done = await softSwitch(ctx, invocation.agent, presetId, roster)
      return { kind: 'success', text: `已柔切到 "${done.preset}"：追加了 ${done.length} 字人设说明，prompt 与工具集未改动，缓存保留。` }
    }
    if (turnIsOpen(ctx, invocation.agent?.session) && options.allowWhileBusy !== true) {
      return {
        kind: 'error',
        text: `当前回合还在运行，结束后再切换到 "${head}"（或把 dsh-preset-manager 的 allowWhileBusy 设为 true）。`,
      }
    }
    const result = await switchPreset(ctx, invocation.agent, head)
    if (!result.changed) return { kind: 'success', text: `当前对话已经在 "${result.to}"。` }
    const moved = result.from === undefined ? `已切换到 "${result.to}"` : `已从 "${result.from}" 切换到 "${result.to}"`
    return { kind: 'success', text: `${moved}，下一步生效。` }
  }
  catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/** Modules whose row carries prompt text we can re-issue as an injected note. */
const PROMPT_ROW_MODULES = new Set(['@deepseek-ai/dsh-persona'])

/**
 * Read a preset's declared plugin rows as the Loader's own YAML.
 * @param registry - the `agentPresets` service.
 * @param presetId - the preset to read.
 * @returns the YAML text, or an empty string when this build cannot read it.
 */
async function readPresetDocument(registry, presetId) {
  if (typeof registry.readDocument !== 'function') return ''
  const document = await registry.readDocument(presetId)
  return typeof document?.content === 'string' ? document.content : ''
}

/**
 * Strip one layer of YAML quoting.
 * @param raw - the scalar as written.
 * @returns the unquoted value.
 */
function stripQuotes(raw) {
  const text = String(raw).trim()
  if (text.length >= 2 && (text[0] === '\'' || text[0] === '"') && text.at(-1) === text[0]) return text.slice(1, -1)
  return text
}

/**
 * Split a dumped entry list into its top-level rows.
 * @param yamlText - output of `readDocument`.
 * @returns one record per row, with the row's own text kept for comparison.
 */
function splitRows(yamlText) {
  const rows = []
  let current
  for (const line of String(yamlText).split(/\r?\n/)) {
    if (/^-\s/u.test(line)) {
      current = [line]
      rows.push(current)
      continue
    }
    if (current !== undefined) current.push(line)
  }
  return rows.map((block) => {
    const text = block.join('\n')
    const id = /^-\s*id:\s*(.+)$/mu.exec(block[0])
    const name = /^\s{2}name:\s*(.+)$/mu.exec(text)
    return {
      ...id === null ? {} : { id: stripQuotes(id[1]) },
      ...name === null ? {} : { name: stripQuotes(name[1]) },
      text,
    }
  })
}

/**
 * Compare two dumped rows lists, ignoring trailing whitespace noise.
 * @param fromRows - rows of the preset being left.
 * @param toRows - rows of the preset being entered.
 * @returns added, removed and changed rows.
 */
function diffRows(fromRows, toRows) {
  const keyOf = (row) => `${row.id ?? ''}\u0000${row.name ?? ''}`
  const normalize = (row) => row.text.replace(/[ \t]+$/gmu, '').trim()
  const from = new Map(fromRows.map((row) => [keyOf(row), row]))
  const to = new Map(toRows.map((row) => [keyOf(row), row]))
  return {
    added: [...to].filter(([key]) => !from.has(key)).map(([, row]) => row),
    removed: [...from].filter(([key]) => !to.has(key)).map(([, row]) => row),
    changed: [...to]
      .filter(([key, row]) => from.has(key) && normalize(from.get(key)) !== normalize(row))
      .map(([, row]) => row),
  }
}

/**
 * Read one block scalar (`key: |-`) out of a row's YAML text.
 * @param rowText - the row as written.
 * @param key - the mapping key holding the block.
 * @returns the block's text, or undefined when the key is absent.
 */
function blockScalar(rowText, key) {
  const lines = String(rowText).split(/\r?\n/u)
  const pattern = new RegExp(`^(\\s*)${key}:\\s*([|>])[-+]?\\s*$`, 'u')
  const start = lines.findIndex((line) => pattern.test(line))
  if (start === -1) return undefined
  const folded = pattern.exec(lines[start])[2] === '>'
  const keyIndent = pattern.exec(lines[start])[1].length
  const collected = []
  let indent
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      collected.push('')
      continue
    }
    const lineIndent = /^\s*/u.exec(line)[0].length
    if (lineIndent <= keyIndent) break
    if (indent === undefined) indent = lineIndent
    collected.push(line.slice(indent))
  }
  const text = folded ? collected.join(' ').replace(/\s+/gu, ' ').trim() : collected.join('\n').trimEnd()
  return text === '' ? undefined : text
}

/**
 * Collect the prompt text a preset declares, for a cache-preserving switch.
 * @param rows - rows parsed out of `readDocument`.
 * @returns the concatenated prompt text, empty when the preset declares none.
 */
function promptTextOf(rows) {
  const parts = []
  for (const row of rows) {
    if (!PROMPT_ROW_MODULES.has(row.name ?? '')) continue
    for (const key of ['prefix', 'suffix']) {
      const text = blockScalar(row.text, key)
      if (text !== undefined) parts.push(text)
    }
  }
  return parts.join('\n\n')
}

/**
 * Build the message a soft switch injects.
 * @param text - the note the model should follow.
 * @returns a frozen user message, or a plain equivalent when the factory is unavailable.
 */
async function buildUserMessage(text) {
  try {
    const llm = await import('@deepseek-ai/dsh-llm')
    if (typeof llm.createUserMessage === 'function') {
      return llm.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    }
  }
  catch {
    // Keeping the switch usable matters more than which factory built the message.
  }
  return {
    id: `preset-manager-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * Switch behaviour without rebinding the preset: the prompt, the tool set and
 * therefore the provider prefix cache all stay as they are, and the target
 * preset's declared prompt text is appended as one model-facing note.
 * @param ctx - the plugin context.
 * @param agent - the calling agent.
 * @param presetId - the requested preset id.
 * @param roster - rows from `agentPresets.list()`.
 * @returns what was appended, so the caller can report it.
 * @throws Error when the preset declares no prompt text or cannot be injected.
 */
async function softSwitch(ctx, agent, presetId, roster) {
  if (agent === undefined || agent === null) throw new Error('柔切需要一个会话上下文的 Agent')
  if (typeof agent.inject !== 'function') throw new Error('这个 dsh 构建的 Agent 不支持 inject()')
  const registry = ctx.agentPresets
  const rows = splitRows(await readPresetDocument(registry, presetId))
  const text = promptTextOf(rows)
  if (text === '') {
    throw new Error(`preset "${presetId}" 没有声明可注入的 prompt 文本，柔切用不了；请用「切换」`)
  }
  const row = roster.find((candidate) => candidate.id === presetId)
  const label = row?.name === undefined ? presetId : `${row.name} (${presetId})`
  const note = `【柔切到 ${label}】本对话的 preset 与工具集不变，下面这段纪律从现在起适用于后续所有步骤：\n\n${text}`
  await agent.inject(await buildUserMessage(note))
  return { preset: presetId, length: text.length }
}

/**
 * Describe what a switch would change in the request prefix.
 * @param ctx - the plugin context.
 * @param from - the preset the conversation runs.
 * @param to - the requested preset.
 * @param roster - rows from `agentPresets.list()`.
 * @returns a report with the row difference and a cache verdict.
 * @throws Error when either declaration cannot be read.
 */
async function diffPresets(ctx, from, to, roster) {
  const registry = ctx.agentPresets
  const [fromRows, toRows] = await Promise.all([
    from === undefined ? Promise.resolve([]) : readPresetDocument(registry, from).then(splitRows),
    readPresetDocument(registry, to).then(splitRows),
  ])
  if (fromRows.length === 0 && toRows.length === 0) {
    throw new Error('这个 dsh 构建读不到 preset 的声明（agentPresets.readDocument），无法做差异检查')
  }
  const delta = diffRows(fromRows, toRows)
  const nameOf = (id) => {
    const row = roster.find((candidate) => candidate.id === id)
    return row?.name === undefined ? id : `${row.name} (${id})`
  }
  const cacheSafe = delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0
  return {
    from,
    to,
    fromLabel: from === undefined ? '(未记录)' : nameOf(from),
    toLabel: nameOf(to),
    added: delta.added,
    removed: delta.removed,
    changed: delta.changed,
    cacheSafe,
  }
}

/**
 * Render a diff report as lines a user or the model can read.
 * @param report - output of {@link diffPresets}.
 * @returns the rendered report.
 */
function formatDiff(report) {
  const describe = (row) => `${row.id ?? '(无 id)'}${row.name === undefined ? '' : ` — ${row.name}`}`
  const lines = [`从 ${report.fromLabel} 到 ${report.toLabel}：`]
  if (report.added.length > 0) lines.push(`+ 新增 ${report.added.length} 行：${report.added.map(describe).join('、')}`)
  if (report.removed.length > 0) lines.push(`- 删除 ${report.removed.length} 行：${report.removed.map(describe).join('、')}`)
  if (report.changed.length > 0) lines.push(`~ 配置改动 ${report.changed.length} 行：${report.changed.map(describe).join('、')}`)
  lines.push(report.cacheSafe
    ? '结论：两套组合声明一致，切换不会改动请求前缀，前缀缓存可以保留。'
    : '结论：请求前缀会变（system prompt 与工具集按声明重新组装），下一轮的前缀缓存将从头计算；要保留缓存请用「柔切」。')
  return lines.join('\n')
}

/**
 * The `preset_list` tool definition.
 * @param ctx - the plugin context.
 * @returns a registry-ready tool definition.
 */
function listTool(ctx) {
  return {
    name: 'preset_list',
    description: LIST_TOOL_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['presets'],
        properties: {
          current: { type: 'string', description: 'Preset id this conversation runs.' },
          default: { type: 'string', description: 'Preset id new sessions start with.' },
          presets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                order: { type: 'number' },
                broken: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `current preset: ${value.current ?? '(none)'}\n`
          + `default for new sessions: ${value.default ?? '(unknown)'}\n\n`
          + formatRoster(value.presets, value.current, value.default),
      }],
    },
    async execute(_args, exec) {
      const registry = ctx.agentPresets
      const roster = await registry.list()
      const current = currentPresetOf(registry, exec.agent)
      const fallback = defaultPresetOf(registry)
      return {
        ...current === undefined ? {} : { current },
        ...fallback === undefined ? {} : { default: fallback },
        presets: roster.map((row) => ({
          id: row.id,
          ...row.name === undefined ? {} : { name: row.name },
          ...row.description === undefined ? {} : { description: row.description },
          ...row.order === undefined ? {} : { order: row.order },
          ...typeof row.broken === 'string' && row.broken.length > 0 ? { broken: row.broken } : {},
        })),
      }
    },
  }
}

/**
 * The `preset_switch` tool definition.
 * @param ctx - the plugin context.
 * @returns a registry-ready tool definition.
 */
function switchTool(ctx) {
  return {
    name: 'preset_switch',
    description: SWITCH_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['preset'],
      properties: {
        preset: { type: 'string', description: 'Exact preset id from preset_list.' },
        mode: {
          type: 'string',
          enum: ['hard', 'soft'],
          description: 'hard rebinds the composition (prompt and tools change, prefix cache resets); soft appends the preset\'s prompt text and keeps both.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['changed', 'to', 'mode'],
        properties: {
          changed: { type: 'boolean', description: 'False for a soft switch and when the conversation already ran that preset.' },
          mode: { type: 'string', enum: ['hard', 'soft'] },
          from: { type: 'string', description: 'Preset the conversation ran before the call.' },
          to: { type: 'string', description: 'Preset that was requested.' },
          note: { type: 'string', description: 'What a soft switch appended.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.mode === 'soft'
          ? `Soft-switched to "${value.to}": its prompt text was appended as one note (${value.note ?? 'text'}), the composition and the prefix cache are unchanged.`
          : value.changed
            ? `Agent preset switched to "${value.to}"${value.from === undefined ? '' : ` from "${value.from}"`}; the new composition applies from the next step.`
            : `The conversation already runs "${value.to}"; nothing changed.`,
      }],
    },
    async execute(args, exec) {
      const presetId = args.preset
      if (typeof presetId !== 'string' || presetId.trim() === '') {
        throw new Error('preset must be a non-empty string')
      }
      const mode = args.mode ?? 'hard'
      if (mode !== 'hard' && mode !== 'soft') throw new Error('mode must be "hard" or "soft"')
      // A tool call always runs inside a turn, so the command's busy guard does
      // not apply: the rebind is picked up by the next step of this same turn.
      const roster = await ctx.agentPresets.list()
      const from = currentPresetOf(ctx.agentPresets, exec.agent)
      if (mode === 'soft') {
        const done = await softSwitch(ctx, exec.agent, presetId.trim(), roster)
        return {
          changed: false,
          mode,
          to: done.preset,
          ...from === undefined ? {} : { from },
          note: `${done.length} characters of prompt text`,
        }
      }
      const result = await switchPreset(ctx, exec.agent, presetId.trim())
      return {
        changed: result.changed,
        mode,
        ...result.from === undefined ? {} : { from: result.from },
        to: result.to,
      }
    },
  }
}

/**
 * The `preset_diff` tool definition.
 * @param ctx - the plugin context.
 * @returns a registry-ready tool definition.
 */
function diffTool(ctx) {
  const rows = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
    },
  }
  return {
    name: 'preset_diff',
    description: DIFF_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['preset'],
      properties: {
        preset: { type: 'string', description: 'Exact preset id to compare against the running one.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['to', 'cacheSafe'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          cacheSafe: { type: 'boolean', description: 'True when the declared rows are identical, so the request prefix is unchanged.' },
          added: rows,
          removed: rows,
          changed: rows,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.cacheSafe
          ? `"${value.to}" declares the same rows as the running preset; a switch keeps the request prefix, so the cache is safe.`
          : `Switching to "${value.to}" changes the request prefix: +${value.added?.length ?? 0} rows, -${value.removed?.length ?? 0} rows, ~${value.changed?.length ?? 0} rows. The prefix cache resets; use preset_switch mode "soft" to keep it.`,
      }],
    },
    async execute(args, exec) {
      const presetId = args.preset
      if (typeof presetId !== 'string' || presetId.trim() === '') {
        throw new Error('preset must be a non-empty string')
      }
      const roster = await ctx.agentPresets.list()
      const report = await diffPresets(ctx, currentPresetOf(ctx.agentPresets, exec.agent), presetId.trim(), roster)
      const simplify = (list) => list.map((row) => ({
        ...row.id === undefined ? {} : { id: row.id },
        ...row.name === undefined ? {} : { name: row.name },
      }))
      return {
        ...report.from === undefined ? {} : { from: report.from },
        to: report.to,
        cacheSafe: report.cacheSafe,
        added: simplify(report.added),
        removed: simplify(report.removed),
        changed: simplify(report.changed),
      }
    },
  }
}

/**
 * Register the command and, unless disabled, the two tools.
 * @param ctx - the plugin context.
 * @param config - the loader row's `config`.
 */
export function apply(ctx, config) {
  const options = readOptions(config)

  // Both registries bind the new entry to the calling context, so unloading
  // this plugin removes the command and the tools with it.
  ctx.commands.register({
    name: options.command,
    description: COMMAND_DESCRIPTION,
    input: { hint: '<preset id> | soft <preset id> | diff <preset id> | list' },
    handler: (invocation) => runCommand(ctx, options, invocation),
  })

  if (options.tools === false) return
  ctx.tools.register(listTool(ctx))
  ctx.tools.register(switchTool(ctx))
  ctx.tools.register(diffTool(ctx))
}