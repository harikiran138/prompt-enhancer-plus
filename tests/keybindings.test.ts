import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

const mount = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'prompt-enhancer-plus', surface, component: 'AbovePrompt', props: PROPS })

// Stands in for the user's environment and keybindings.json; null means no file.
function keybindings(on: On, file: object | null) {
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('fs.read', (_$, e) =>
    file && e.path === '/home/me/.claude/keybindings.json' ? { value: JSON.stringify(file) } : { deny: 'ENOENT' },
  )
}

const START = { cwd: '/work/app', surface: 'terminal', isInteractive: true } as const

async function hintAfterStart($: Engine) {
  await $.session.start(START)
  const ui = await mount($, 'terminal')
  const found = await ui.find({ type: 'Text', text: /e enhance · s send/ })
  await ui.unmount()
  return found?.text
}

test('The hint shows the chord the user bound to abovePrompt:focus', async ($, on) => {
  keybindings(on, {
    bindings: [
      { context: 'Chat', bindings: { 'Cmd+Enter': 'chat:submit' } },
      { context: 'Chat', bindings: { 'cmd+e': 'abovePrompt:focus' } },
    ],
  })
  expect(await hintAfterStart($)).toContain('cmd+e · e enhance · s send · m mode · esc back')
})

test('The hint falls back to ctrl+x tab without a keybindings file', async ($, on) => {
  keybindings(on, null)
  expect(await hintAfterStart($)).toContain('ctrl+x tab · e enhance · s send · m mode · esc back')
})

test('The hint drops the chord when the user unbound ctrl+x tab and bound nothing else', async ($, on) => {
  keybindings(on, { bindings: [{ context: 'Chat', bindings: { 'ctrl+x tab': null } }] })
  const hint = await hintAfterStart($)
  expect(hint).toContain('e enhance · s send · m mode · esc back')
  expect(hint).not.toContain('ctrl+x')
})
