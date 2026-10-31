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

const COMMAND_DESCRIPTION = '列出本 profile 的 Agent preset，或把当前对话切换到另一个 preset'

const LIST_TOOL_DESCRIPTION = 'List the Agent presets installed in this Harness profile. '
  + 'Each row carries the exact id to pass to preset_switch, the display name, the declared order, '
  + 'and a `broken` diagnostic when the preset\'s plugins failed to load. '
  + '`current` is the preset this conversation runs; `default` is the one new sessions start with. '
  + 'Call this before preset_switch so the id is exact.'

const SWITCH_TOOL_DESCRIPTION = 'Switch this conversation to another Agent preset, which changes the '
  + 'prompt, tools, and skills available from the next step. '
  + 'The switch is recorded in the session log and applies immediately: the current turn continues, '
  + 'and the next model step assembles the new composition. '
  + 'Use preset_list first for exact ids; switching to the current preset is a no-op. '
  + 'The whole prompt prefix changes, so do not switch back and forth without a reason.'

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
 * Drive `/preset`: no input lists the roster, `<id>` switches the conversation.
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
    if (raw === '' || raw === 'list') {
      return { kind: 'success', text: formatRoster(roster, current, fallback) }
    }
    const [presetId] = raw.split(/\s+/u)
    if (turnIsOpen(ctx, invocation.agent?.session) && options.allowWhileBusy !== true) {
      return {
        kind: 'error',
        text: `当前回合还在运行，结束后再切换到 "${presetId}"（或把 dsh-preset-manager 的 allowWhileBusy 设为 true）。`,
      }
    }
    const result = await switchPreset(ctx, invocation.agent, presetId)
    if (!result.changed) return { kind: 'success', text: `当前对话已经在 "${result.to}"。` }
    const moved = result.from === undefined ? `已切换到 "${result.to}"` : `已从 "${result.from}" 切换到 "${result.to}"`
    return { kind: 'success', text: `${moved}，下一步生效。` }
  }
  catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
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
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['changed', 'to'],
        properties: {
          changed: { type: 'boolean', description: 'False when the conversation already ran that preset.' },
          from: { type: 'string', description: 'Preset the conversation ran before the switch.' },
          to: { type: 'string', description: 'Preset the conversation runs now.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.changed
          ? `Agent preset switched to "${value.to}"${value.from === undefined ? '' : ` from "${value.from}"`}; the new composition applies from the next step.`
          : `The conversation already runs "${value.to}"; nothing changed.`,
      }],
    },
    async execute(args, exec) {
      const presetId = args.preset
      if (typeof presetId !== 'string' || presetId.trim() === '') {
        throw new Error('preset must be a non-empty string')
      }
      // A tool call always runs inside a turn, so the command's busy guard does
      // not apply: the rebind is picked up by the next step of this same turn.
      const result = await switchPreset(ctx, exec.agent, presetId.trim())
      return {
        changed: result.changed,
        ...result.from === undefined ? {} : { from: result.from },
        to: result.to,
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
    input: { hint: `<preset id> | list` },
    handler: (invocation) => runCommand(ctx, options, invocation),
  })

  if (options.tools === false) return
  ctx.tools.register(listTool(ctx))
  ctx.tools.register(switchTool(ctx))
}