import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name as pluginName, inject as pluginInject } from '../index.js'

/** One fake preset roster row. */
const ROSTER = [
  { id: 'standard', name: '标准模式', description: '内置标准组合', order: 10 },
  { id: 'whale-elite', name: '鲸英模式', description: '降低出错率', order: 20 },
  { id: 'broken-one', name: '坏掉的', broken: 'tool-fs: import failed' },
]

/** Declared rows used by the diff and soft-switch cases. */
const DOCS = {
  standard: `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      你在标准模式下工作。
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    readLimit: 2000
`,
  'whale-elite': `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: |-
      三、失败与不确定
      - 命令失败要如实报告退出码。
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    readLimit: 4000
- id: tool-str-replace
  name: '@deepseek-ai/dsh-tool-str-replace'
`,
  'broken-one': '',
}

/**
 * Build a plugin context stand-in with the three services the plugin touches.
 * @param options - overrides for roster, current preset, projections and config.
 * @returns the context plus the recorded registry calls.
 */
function createHarness(options = {}) {
  const calls = { recompose: [], appended: [], commands: [], tools: [], injected: [] }
  const state = { current: options.current }
  const agent = { id: 'session-1', ctx: { marker: 'agent-ctx' }, session: { id: 'session-1' } }

  const registry = {
    defaultId: options.defaultId,
    async list() { return options.roster ?? ROSTER },
    composedPreset(ctx) {
      assert.equal(ctx, agent.ctx, 'composedPreset must be read from the agent context')
      return state.current
    },
    async recompose(ctx, id) {
      assert.equal(ctx, agent.ctx, 'recompose must target the agent context')
      calls.recompose.push(id)
      state.current = id
    },
    async readDocument(id) {
      return { agentPreset: id, content: DOCS[id] ?? '' }
    },
  }

  const services = {
    commands: { register(definition) { calls.commands.push(definition); return () => {} } },
    tools: { register(definition) { calls.tools.push(definition); return () => {} } },
    ...options.projections === undefined ? {} : { sessionProjections: options.projections },
  }

  const append = (type, data) => { calls.appended.push({ type, data }) }
  agent.session = { id: 'session-1', append }
  if (options.inject !== false) agent.inject = (message) => { calls.injected.push(message) }

  const ctx = {
    agentPresets: registry,
    commands: services.commands,
    tools: services.tools,
    get: (serviceName) => services[serviceName],
  }

  apply(ctx, options.config)
  return { calls, agent, state, services }
}

/**
 * Flatten an injected user message back to its text.
 * @param message - the recorded message.
 * @returns its text content.
 */
function messageText(message) {
  return message.content.map((part) => part.text).join('')
}

test('declares the loader row name and its injected services', () => {
  assert.equal(pluginName, 'dsh-preset-manager')
  assert.deepEqual(pluginInject, ['agentPresets', 'commands', 'tools'])
})

test('registers one command and three tools by default', () => {
  const { calls } = createHarness()
  assert.equal(calls.commands.length, 1)
  assert.equal(calls.commands[0].name, 'preset')
  assert.equal(typeof calls.commands[0].description, 'string')
  assert.equal(calls.commands[0].input.hint, '<preset id> | soft <preset id> | diff <preset id> | list')
  assert.deepEqual(calls.tools.map((tool) => tool.name), ['preset_list', 'preset_switch', 'preset_diff'])
})

test('honours a custom command name and can disable the tools', () => {
  const { calls } = createHarness({ config: { command: 'agent-preset', tools: false } })
  assert.equal(calls.commands[0].name, 'agent-preset')
  assert.equal(calls.tools.length, 0)
})

test('rejects an unusable config at load time', () => {
  assert.throws(() => createHarness({ config: { command: 'Preset' } }), /config\.command/u)
  assert.throws(() => createHarness({ config: { tools: 'yes' } }), /config\.tools/u)
  assert.throws(() => createHarness({ config: { allowWhileBusy: 1 } }), /config\.allowWhileBusy/u)
  assert.throws(() => createHarness({ config: ['x'] }), /config must be an object/u)
})

test('listing marks the running preset and the new-session default', async () => {
  const { calls, agent } = createHarness({ current: 'standard', defaultId: 'whale-elite' })
  const result = await calls.commands[0].handler({ agent, rawInput: '' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /标准模式 \(standard\) \[当前\]/u)
  assert.match(result.text, /鲸英模式 \(whale-elite\) \[新会话默认\]/u)
  assert.match(result.text, /broken-one.*\[加载失败\]/u)
  assert.deepEqual(calls.recompose, [])
})

test('switching rebinds the agent and records the session event', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: '  whale-elite  ' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已从 "standard" 切换到 "whale-elite"/u)
  assert.deepEqual(calls.recompose, ['whale-elite'])
  assert.deepEqual(calls.appended, [{ type: 'agent-preset/selected', data: { agentPreset: 'whale-elite' } }])
})

test('an unknown preset is an error and changes nothing', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'nope' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知 preset "nope"/u)
  assert.match(result.text, /whale-elite/u)
  assert.deepEqual(calls.recompose, [])
  assert.deepEqual(calls.appended, [])
})

test('a broken preset is refused instead of mounted', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'broken-one' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /加载失败/u)
  assert.deepEqual(calls.recompose, [])
})

test('switching to the running preset is a no-op', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'standard' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已经在 "standard"/u)
  assert.deepEqual(calls.recompose, [])
})

test('an open turn is refused unless allowWhileBusy is set', async () => {
  const projections = { stateOf: () => ({ openTurnStartSeq: 42, lastTurn: 3 }) }
  const busy = createHarness({ current: 'standard', projections })
  const refused = await busy.calls.commands[0].handler({ agent: busy.agent, rawInput: 'whale-elite' })
  assert.equal(refused.kind, 'error')
  assert.match(refused.text, /当前回合还在运行/u)
  assert.deepEqual(busy.calls.recompose, [])

  const permissive = createHarness({ current: 'standard', projections, config: { allowWhileBusy: true } })
  const allowed = await permissive.calls.commands[0].handler({ agent: permissive.agent, rawInput: 'whale-elite' })
  assert.equal(allowed.kind, 'success')
  assert.deepEqual(permissive.calls.recompose, ['whale-elite'])
})

test('a missing turn projection does not block the switch', async () => {
  const { calls, agent } = createHarness({ current: 'standard', projections: {} })
  const result = await calls.commands[0].handler({ agent, rawInput: 'whale-elite' })
  assert.equal(result.kind, 'success')
})

test('preset_list reports the roster, the running preset and the default', async () => {
  const { calls, agent } = createHarness({ current: 'standard', defaultId: 'whale-elite' })
  const tool = calls.tools.find((candidate) => candidate.name === 'preset_list')
  const value = await tool.execute({}, { agent })
  assert.equal(value.current, 'standard')
  assert.equal(value.default, 'whale-elite')
  assert.deepEqual(value.presets.map((row) => row.id), ['standard', 'whale-elite', 'broken-one'])
  assert.equal(value.presets[2].broken, 'tool-fs: import failed')
  const [content] = tool.output.render({}, value)
  assert.match(content.text, /current preset: standard/u)
})

test('preset_switch rebinds and reports the move', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const tool = calls.tools.find((candidate) => candidate.name === 'preset_switch')
  const value = await tool.execute({ preset: 'whale-elite' }, { agent })
  assert.deepEqual(value, { changed: true, mode: 'hard', from: 'standard', to: 'whale-elite' })
  assert.deepEqual(calls.recompose, ['whale-elite'])
})

test('preset_switch validates its argument and requires an agent', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const tool = calls.tools.find((candidate) => candidate.name === 'preset_switch')
  await assert.rejects(() => tool.execute({ preset: '   ' }, { agent }), /non-empty string/u)
  await assert.rejects(() => tool.execute({ preset: 'whale-elite' }, {}), /owning agent session/u)
})

test('concurrent switches are serialized onto one agent scope', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const tool = calls.tools.find((candidate) => candidate.name === 'preset_switch')
  const [first, second] = await Promise.all([
    tool.execute({ preset: 'whale-elite' }, { agent }),
    tool.execute({ preset: 'standard' }, { agent }),
  ])
  assert.deepEqual(calls.recompose, ['whale-elite', 'standard'])
  assert.equal(first.changed, true)
  assert.equal(second.changed, true)
  assert.deepEqual(calls.appended.map((event) => event.data.agentPreset), ['whale-elite', 'standard'])
})

test('diff reports the declared row delta and the cache verdict', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'diff whale-elite' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /新增 1 行：tool-str-replace/u)
  assert.match(result.text, /配置改动 2 行：persona/u)
  assert.match(result.text, /前缀缓存将从头计算/u)
  assert.deepEqual(calls.recompose, [])
})

test('diff of an identical declaration reports a cache-safe switch', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'diff standard' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /声明一致/u)
  assert.match(result.text, /可以保留/u)
})

test('soft switch appends the declared prompt text and leaves the preset alone', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'soft whale-elite' })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /已柔切到 "whale-elite"/u)
  assert.deepEqual(calls.recompose, [])
  assert.deepEqual(calls.appended, [])
  assert.equal(calls.injected.length, 1)
  const text = messageText(calls.injected[0])
  assert.match(text, /柔切到 鲸英模式 \(whale-elite\)/u)
  assert.match(text, /命令失败要如实报告退出码/u)
  assert.equal(calls.injected[0].role, 'user')
})

test('soft switch refuses a preset that declares no prompt text', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const result = await calls.commands[0].handler({ agent, rawInput: 'soft broken-one' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有声明可注入的 prompt 文本/u)
  assert.equal(calls.injected.length, 0)
})

test('soft switch needs an agent that can take an injected message', async () => {
  const { calls, agent } = createHarness({ current: 'standard', inject: false })
  const result = await calls.commands[0].handler({ agent, rawInput: 'soft whale-elite' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /不支持 inject/u)
})

test('subcommands need a preset id', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  for (const rawInput of ['soft', 'diff']) {
    const result = await calls.commands[0].handler({ agent, rawInput })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /用法/u)
  }
})

test('preset_switch mode soft reports no rebind and injects instead', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const tool = calls.tools.find((candidate) => candidate.name === 'preset_switch')
  const value = await tool.execute({ preset: 'whale-elite', mode: 'soft' }, { agent })
  assert.equal(value.changed, false)
  assert.equal(value.mode, 'soft')
  assert.equal(value.to, 'whale-elite')
  assert.match(value.note, /characters of prompt text/u)
  assert.deepEqual(calls.recompose, [])
  assert.equal(calls.injected.length, 1)
  await assert.rejects(() => tool.execute({ preset: 'whale-elite', mode: 'sideways' }, { agent }), /mode must be/u)
})

test('preset_diff returns the structured delta', async () => {
  const { calls, agent } = createHarness({ current: 'standard' })
  const tool = calls.tools.find((candidate) => candidate.name === 'preset_diff')
  const value = await tool.execute({ preset: 'whale-elite' }, { agent })
  assert.equal(value.from, 'standard')
  assert.equal(value.to, 'whale-elite')
  assert.equal(value.cacheSafe, false)
  assert.deepEqual(value.added, [{ id: 'tool-str-replace', name: '@deepseek-ai/dsh-tool-str-replace' }])
  assert.deepEqual(value.changed.map((row) => row.id), ['persona', 'tool-fs'])
  assert.deepEqual(value.removed, [])
  const [content] = tool.output.render({}, value)
  assert.match(content.text, /prefix cache resets/u)
})