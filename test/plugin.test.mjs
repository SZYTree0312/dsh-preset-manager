import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name as pluginName, inject as pluginInject } from '../index.js'

/** One fake preset roster row. */
const ROSTER = [
  { id: 'standard', name: '标准模式', description: '内置标准组合', order: 10 },
  { id: 'whale-elite', name: '鲸英模式', description: '降低出错率', order: 20 },
  { id: 'broken-one', name: '坏掉的', broken: 'tool-fs: import failed' },
]

/**
 * Build a plugin context stand-in with the three services the plugin touches.
 * @param options - overrides for roster, current preset, projections and config.
 * @returns the context plus the recorded registry calls.
 */
function createHarness(options = {}) {
  const calls = { recompose: [], appended: [], commands: [], tools: [] }
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
  }

  const services = {
    commands: { register(definition) { calls.commands.push(definition); return () => {} } },
    tools: { register(definition) { calls.tools.push(definition); return () => {} } },
    ...options.projections === undefined ? {} : { sessionProjections: options.projections },
  }

  const append = (type, data) => { calls.appended.push({ type, data }) }
  agent.session = { id: 'session-1', append }

  const ctx = {
    agentPresets: registry,
    commands: services.commands,
    tools: services.tools,
    get: (serviceName) => services[serviceName],
  }

  apply(ctx, options.config)
  return { calls, agent, state, services }
}

test('declares the loader row name and its injected services', () => {
  assert.equal(pluginName, 'dsh-preset-manager')
  assert.deepEqual(pluginInject, ['agentPresets', 'commands', 'tools'])
})

test('registers one command and two tools by default', () => {
  const { calls } = createHarness()
  assert.equal(calls.commands.length, 1)
  assert.equal(calls.commands[0].name, 'preset')
  assert.equal(typeof calls.commands[0].description, 'string')
  assert.equal(calls.commands[0].input.hint, '<preset id> | list')
  assert.deepEqual(calls.tools.map((tool) => tool.name), ['preset_list', 'preset_switch'])
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
  assert.deepEqual(value, { changed: true, from: 'standard', to: 'whale-elite' })
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