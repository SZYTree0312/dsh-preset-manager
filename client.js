/**
 * dsh-preset-manager — browser half.
 *
 * One header control beside the session title: it names the preset this
 * conversation runs and opens a menu that switches it. Every action is a Host
 * command (`/<command> …`), so the click path and the typed path run the same
 * code: `hard` rebinds the composition, `soft` appends the target preset's
 * prompt text and keeps the prompt prefix (and its cache) intact.
 *
 * Nothing here imports a Harness package; React comes from the browser module
 * table and every value is read through the Remote namespaces the Host exposes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-preset-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const TEXT = {
      zh: {
        trigger: '切换预设',
        unset: '未记录预设',
        title: '切换 Agent 预设',
        loading: '正在读取预设…',
        empty: '这个 profile 没有可用预设',
        hard: '切换',
        soft: '柔切',
        hardTitle: '真切换：prompt 与工具集都换，下一轮缓存从头算',
        softTitle: '柔切：prompt 与工具集不变，只追加一段人设说明，缓存保留',
        current: '当前',
        failed: '读取预设失败',
      },
      en: {
        trigger: 'Switch preset',
        unset: 'No preset recorded',
        title: 'Switch Agent preset',
        loading: 'Reading presets…',
        empty: 'This profile has no presets',
        hard: 'Switch',
        soft: 'Keep cache',
        hardTitle: 'Hard switch: prompt and tools change, next prefix cache resets',
        softTitle: 'Soft switch: prompt and tools stay, one note is appended, cache kept',
        current: 'current',
        failed: 'Failed to read presets',
      },
    }

    /**
     * Pick a dictionary from the browser's own language.
     * @returns the message table for this page.
     */
    function messages() {
      const language = String((typeof navigator === 'object' && navigator !== null && navigator.language) || 'en')
      return language.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en
    }

    /** Fixed for the life of the page, so hooks can depend on it. */
    const TEXT_TABLE = messages()

    const STYLE_ID = 'dsh-preset-manager/header-menu'
    const CSS = [
      '.dpm-wrap{position:relative;display:inline-flex;align-items:center}',
      '.dpm-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;max-width:220px}',
      '.dpm-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary)}',
      '.dpm-trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary)}',
      '.dpm-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dpm-caret{font-size:9px;opacity:.7}',
      '.dpm-menu{position:fixed;z-index:60;min-width:300px;max-width:min(420px,92vw);max-height:62vh;overflow:auto;padding:6px;border-radius:12px;background:var(--dsw-alias-bg-module-platform,#fff);border:1px solid var(--dsw-alias-settings-card-stroke,rgba(0,0,0,.1));box-shadow:0 14px 34px rgba(0,0,0,.18)}',
      '.dpm-title{padding:6px 8px 4px;font-size:11px;color:var(--dsw-alias-label-quaternary,#999);letter-spacing:.04em}',
      '.dpm-row{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;padding:8px;border-radius:8px}',
      '.dpm-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.dpm-copy{min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dpm-name{font-size:13px;color:var(--dsw-alias-label-primary);display:flex;gap:6px;align-items:baseline}',
      '.dpm-badge{font-size:11px;color:var(--dsw-alias-state-business-primary,#247bbf)}',
      '.dpm-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary,#888);overflow-wrap:anywhere;max-height:32px;overflow:hidden}',
      '.dpm-actions{display:flex;gap:4px;flex:none;padding-top:2px}',
      '.dpm-act{height:24px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.dpm-act:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
      '.dpm-act[data-primary="true"]{color:var(--dsw-alias-state-business-primary,#247bbf);border-color:currentColor}',
      '.dpm-act[disabled]{opacity:.5;cursor:default}',
      '.dpm-notice{padding:8px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l,rgba(0,0,0,.1));font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.dpm-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary,#d33)}',
    ].join('')

    /**
     * Install the stylesheet once per page.
     * @returns the style element this call created, or undefined when one existed.
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return undefined
      const selector = 'style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']'
      if (document.querySelector(selector) !== null) return undefined
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-preset-manager'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return tag
    }

    /**
     * The header control: current preset name, and a menu of the roster.
     * @param props - composed slot props plus the `remote` namespaces.
     * @returns the control, or null outside a session.
     */
    function PresetSwitcher(props) {
      const { sessionId, useSessions, remote } = props
      const t = TEXT_TABLE
      // A slot that does not hand out a session store cannot support a switch.
      if (typeof useSessions !== 'function') return null
      const current = useSessions((state) => {
        if (state === undefined || state.byId === undefined) return undefined
        const entry = state.byId[sessionId]
        if (entry === undefined || entry.projectionValues === undefined) return undefined
        const preset = entry.projectionValues.agentPreset
        return typeof preset === 'string' ? preset : undefined
      })
      const [open, setOpen] = React.useState(false)
      const [place, setPlace] = React.useState(undefined)
      const [roster, setRoster] = React.useState({ status: 'idle', presets: [], error: undefined })
      const [busy, setBusy] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const anchor = React.useRef(null)

      const load = React.useCallback(async () => {
        setRoster((previous) => ({ status: 'loading', presets: previous.presets, error: undefined }))
        try {
          const result = await remote.agentPresets.list()
          if (!result || result.ok !== true) {
            const message = result === undefined || result.error === undefined ? t.failed : result.error.message
            setRoster({ status: 'error', presets: [], error: message })
            return
          }
          const presets = result.value === undefined || result.value.presets === undefined ? [] : result.value.presets
          setRoster({ status: 'ready', presets, error: undefined })
        }
        catch (error) {
          setRoster({ status: 'error', presets: [], error: error instanceof Error ? error.message : String(error) })
        }
      }, [remote, t])

      React.useEffect(() => {
        if (open) load()
      }, [open, load])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (anchor.current !== null && anchor.current.contains(event.target)) return
          const menu = document.getElementById('dpm-menu')
          if (menu !== null && menu.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      if (sessionId === undefined || sessionId === null) return null

      const openMenu = () => {
        const box = anchor.current === null ? undefined : anchor.current.getBoundingClientRect()
        if (box !== undefined) {
          setPlace({
            top: Math.round(box.bottom + 6),
            right: Math.round(Math.max(8, (window.innerWidth || 0) - box.right)),
          })
        }
        setNotice(undefined)
        setOpen((value) => !value)
      }

      const run = async (presetId, mode) => {
        setBusy(presetId + ':' + mode)
        setNotice(undefined)
        const line = mode === 'soft' ? '/preset soft ' + presetId : '/preset ' + presetId
        try {
          const result = await remote.commands.execute(sessionId, line, [])
          if (!result || result.ok !== true) {
            const message = result === undefined || result.error === undefined ? 'command failed' : result.error.message
            setNotice({ kind: 'error', text: message })
            return
          }
          const outcome = result.value === undefined ? undefined : result.value.result
          if (outcome === undefined) {
            setNotice({ kind: 'error', text: 'unknown command: ' + line })
            return
          }
          setNotice({ kind: outcome.kind, text: outcome.text })
          if (outcome.kind === 'success') load()
        }
        catch (error) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        }
        finally {
          setBusy(undefined)
        }
      }

      const nameOf = (id) => {
        const row = roster.presets.find((candidate) => candidate.id === id)
        return row === undefined || typeof row.name !== 'string' ? id : row.name
      }
      const healthy = roster.presets.filter((row) => row.broken === undefined)
      const triggerText = current === undefined ? t.unset : nameOf(current)

      const menuRows = healthy.map((row) => {
        const id = row.id
        const working = busy !== undefined && busy.startsWith(id + ':')
        const isCurrent = id === current
        return h('div', { className: 'dpm-row', key: id },
          h('div', { className: 'dpm-copy' },
            h('div', { className: 'dpm-name' },
              row.name === undefined ? id : row.name,
              isCurrent ? h('span', { className: 'dpm-badge' }, t.current) : null,
            ),
            h('div', { className: 'dpm-desc' },
              row.description === undefined ? id : row.description,
            ),
          ),
          h('div', { className: 'dpm-actions' },
            h('button', {
              type: 'button',
              className: 'dpm-act',
              'data-primary': 'true',
              title: t.hardTitle,
              disabled: working || isCurrent,
              onClick: () => run(id, 'hard'),
            }, t.hard),
            h('button', {
              type: 'button',
              className: 'dpm-act',
              title: t.softTitle,
              disabled: working,
              onClick: () => run(id, 'soft'),
            }, t.soft),
          ),
        )
      })

      const body = roster.status === 'loading' && healthy.length === 0
        ? h('div', { className: 'dpm-notice' }, t.loading)
        : roster.status === 'error'
          ? h('div', { className: 'dpm-notice', 'data-kind': 'error' }, roster.error ?? t.failed)
          : healthy.length === 0
            ? h('div', { className: 'dpm-notice' }, t.empty)
            : menuRows

      return h('span', { className: 'dpm-wrap', ref: anchor },
        h('button', {
          type: 'button',
          className: 'dpm-trigger',
          title: t.title,
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: openMenu,
        },
          h('span', { className: 'dpm-label' }, triggerText),
          h('span', { className: 'dpm-caret', 'aria-hidden': 'true' }, '▼'),
        ),
        open && place !== undefined
          ? h('div', {
            className: 'dpm-menu',
            id: 'dpm-menu',
            role: 'menu',
            style: { top: place.top + 'px', right: place.right + 'px' },
          },
            h('div', { className: 'dpm-title' }, t.title),
            body,
            notice === undefined ? null : h('div', { className: 'dpm-notice', 'data-kind': notice.kind }, notice.text),
          )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const installStyles = () => {
          const tag = ensureStyles()
          return () => {
            if (tag !== undefined && tag.parentNode !== null) tag.parentNode.removeChild(tag)
          }
        }
        if (typeof ctx.effect === 'function') ctx.effect(installStyles)
        else installStyles()

        const remote = ctx.remote !== undefined
          ? ctx.remote
          : typeof ctx.get === 'function' ? ctx.get('remote') : undefined

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'preset-manager',
          order: 5,
          inject: () => ({ remote }),
        }, PresetSwitcher))
      },
    }
  },
})