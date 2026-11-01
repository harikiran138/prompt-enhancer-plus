import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, ModelForkResult, ModelUsage, On, RenderPropsOf } from 'claude-code'

const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}
const USAGE = {} as ModelUsage
const SURFACES = ['terminal', 'desktop'] as const

type Fake = {
  text: string
  submitted: string[]
  asUser: (true | undefined)[]
  asks: string[]
  fork: ModelForkResult
  complete: ModelCompleteResult
}

// Stands in for the prompt box and the model beneath the plugin; each surface run resets it.
function engine(on: On): Fake {
  const fake: Fake = {
    text: '',
    submitted: [],
    asUser: [],
    asks: [],
    fork: { isAnswered: false, reason: 'nothing-to-fork' },
    complete: { isAnswered: false, reason: 'empty-reply', usage: USAGE },
  }
  // What the engine draws in the band beneath the plugins: its own tree (an `engine` node).
  on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))
  on('prompt.read', () => ({ value: { text: fake.text, cursor: fake.text.length } }))
  on('prompt.fill', (_$, e) => {
    fake.text = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_$, e) => {
    fake.submitted.push(e.text)
    fake.asUser.push(e.origin?.kind === 'plugin' ? e.origin.asUser : undefined)
    return { text: e.text }
  })
  on('model.fork', (_$, e) => {
    fake.asks.push(e.prompt)
    return { value: fake.fork }
  })
  on('model.complete', (_$, e) => {
    fake.asks.push(String(e.system))
    return { value: fake.complete }
  })
  on('session.cwd', () => ({ value: '/work/app' }))
  on('session.usage', () => ({
    value: {
      context: { breakdown: { skills: { skillFrontmatter: [{ name: 'ui-styling' }, { name: 'debug' }] } } },
    } as never,
  }))
  return fake
}

function reset(fake: Fake, text: string) {
  Object.assign(fake, { text, submitted: [], asUser: [], asks: [] })
}

const mount = ($: Engine, surface: (typeof SURFACES)[number]) =>
  $.ui.mount({ plugin: 'prompt-enhancer-plus', surface, component: 'AbovePrompt', props: PROPS })

test('Enhance rewrites the draft in place from the forked session', async ($, on) => {
  const fake = engine(on)
  for (const surface of SURFACES) {
    reset(fake, 'add dark mode')
    fake.fork = { isAnswered: true, text: '<prompt>Add a dark mode toggle. Use the ui-styling skill.</prompt>', usage: USAGE }
    const ui = await mount($, surface)
    await ui.press({ key: 'enhance' })
    expect(fake.text).toBe('Add a dark mode toggle. Use the ui-styling skill.')
    expect(fake.asks[0]).toContain('<rough_prompt>\nadd dark mode\n</rough_prompt>')
    expect(fake.submitted).toEqual([])
    await ui.unmount()
  }
})

test('Enhance falls back to a plain completion before the first turn', async ($, on) => {
  const fake = engine(on)
  for (const surface of SURFACES) {
    reset(fake, 'fix login')
    fake.fork = { isAnswered: false, reason: 'nothing-to-fork' }
    fake.complete = { isAnswered: true, text: '<prompt>Fix the login bug.</prompt>', usage: USAGE }
    const ui = await mount($, surface)
    await ui.press({ key: 'enhance' })
    expect(fake.text).toBe('Fix the login bug.')
    expect(fake.asks).toContain('Project folder: /work/app')
    const sent = fake.asks.join('\n')
    expect(sent).toContain('<installed_skills>\nui-styling, debug\n</installed_skills>')
    expect(sent).toContain('Fix every spelling, typo, grammar and punctuation error')
    expect(sent).toContain('<templates>')
    expect(sent).toContain('Use these skills:')
    await ui.unmount()
  }
})

test('Enhance leaves the draft alone and says why when the model fails', async ($, on) => {
  const fake = engine(on)
  for (const surface of SURFACES) {
    reset(fake, 'refactor auth')
    fake.fork = { isAnswered: false, reason: 'empty-reply', usage: USAGE }
    const ui = await mount($, surface)
    await ui.press({ key: 'enhance' })
    expect(fake.text).toBe('refactor auth')
    expect(await ui.find({ type: 'Text', text: /Enhance failed: model call failed: empty-reply/ })).toBeDefined()
    await ui.unmount()
  }
})

test('The row tells a terminal user the keys, and only a terminal user', async ($, on) => {
  engine(on)
  const HINT = /ctrl\+x tab · e enhance · s send · esc back/
  const terminal = await mount($, 'terminal')
  expect(await terminal.find({ type: 'Text', text: HINT })).toBeDefined()
  await terminal.unmount()
  const desktop = await mount($, 'desktop')
  expect(await desktop.find({ type: 'Text', text: HINT })).toBeUndefined()
  await desktop.unmount()
})

test('The row stays during a running turn, Enhance works there, and the hint says Send queues', async ($, on) => {
  const fake = engine(on)
  for (const surface of SURFACES) {
    reset(fake, 'add a readme')
    fake.fork = { isAnswered: true, text: '<prompt>Add a README.</prompt>', usage: USAGE }
    const ui = await $.ui.mount({
      plugin: 'prompt-enhancer-plus',
      surface,
      component: 'AbovePrompt',
      props: { ...PROPS, isWorking: true },
    })
    expect(await ui.find({ key: 'enhance' })).toBeDefined()
    expect(await ui.find({ key: 'send' })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /e enhance · s queue · esc back/ })).toBeDefined()
    }
    await ui.press({ key: 'enhance' })
    expect(fake.text).toBe('Add a README.')
    expect(fake.submitted).toEqual([])
    await ui.unmount()
  }
})

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
  expect(await hintAfterStart($)).toContain('cmd+e · e enhance · s send · esc back')
})

test('The hint falls back to ctrl+x tab without a keybindings file', async ($, on) => {
  keybindings(on, null)
  expect(await hintAfterStart($)).toContain('ctrl+x tab · e enhance · s send · esc back')
})

test('The hint drops the chord when the user unbound ctrl+x tab and bound nothing else', async ($, on) => {
  keybindings(on, { bindings: [{ context: 'Chat', bindings: { 'ctrl+x tab': null } }] })
  const hint = await hintAfterStart($)
  expect(hint).toContain('e enhance · s send · esc back')
  expect(hint).not.toContain('ctrl+x')
})

test('Send submits the draft and clears the box', async ($, on) => {
  const fake = engine(on)
  for (const surface of SURFACES) {
    reset(fake, 'ship it')
    const ui = await mount($, surface)
    await ui.press({ key: 'send' })
    expect(fake.submitted).toEqual(['ship it'])
    expect(fake.asUser).toEqual([true])
    expect(fake.text).toBe('')
    await ui.unmount()
  }
})
