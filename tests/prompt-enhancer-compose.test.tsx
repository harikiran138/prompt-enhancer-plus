// The band composes: its row, and beneath it whatever the rest of the chain drew. A plugin in the
// `prepend` tier sits outside this mod (it calls the mod through next), one in `append` inside it.
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

// The engine's own drawing, beneath every plugin.
const engine = (on: On) => on('ui.render', () => ({ type: 'engine' as const, ref: 0 }))

const mount = ($: Engine, props: RenderPropsOf['AbovePrompt'] = PROPS) =>
  $.ui.mount({ plugin: 'prompt-enhancer-plus', surface: 'terminal', component: 'AbovePrompt', props })
type Band = Awaited<ReturnType<typeof mount>>
const keysOf = async (ui: Band) => (await ui.findAll({ type: 'Button' })).map(b => b.key)
const hasEngine = async (ui: Band) => JSON.stringify(await ui.drawn()).includes('"type":"engine"')

const composingPeer = (tier: 'prepend' | 'append') => ({
  name: 'peer-compose',
  tier,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const below = await next(e)
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          <Button key="peer-row" label="Peer" onPress={() => {}} />
          {below}
        </Box>
      )
    })
  },
})

// A band that draws alone, as prompt-enhancer v0.2.0 did.
const stubbornPeer = (tier: 'prepend' | 'append') => ({
  name: 'peer-alone',
  tier,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box>
          <Button key="peer-alone" label="Alone" onPress={() => {}} />
        </Box>
      )
    })
  },
})

test('The row is drawn with the engine drawing beneath it', async ($, on) => {
  engine(on)
  const ui = await mount($)
  expect(await keysOf(ui)).toEqual(['enhance', 'send', 'mode'])
  expect(await hasEngine(ui)).toBe(true)
  await ui.unmount()
})

test('Peer outside, composing: both rows and the engine drawing show', { plugins: [composingPeer('prepend')] }, async ($, on) => {
  engine(on)
  const ui = await mount($)
  expect(await keysOf(ui)).toEqual(['peer-row', 'enhance', 'send', 'mode'])
  expect(await hasEngine(ui)).toBe(true)
  await ui.unmount()
})

test('Peer inside, composing: both rows and the engine drawing show', { plugins: [composingPeer('append')] }, async ($, on) => {
  engine(on)
  const ui = await mount($)
  expect(await keysOf(ui)).toEqual(['enhance', 'send', 'mode', 'peer-row'])
  expect(await hasEngine(ui)).toBe(true)
  await ui.unmount()
})

test('Peer inside that draws alone: the row, outside it, still shows above the peer', { plugins: [stubbornPeer('append')] }, async ($, on) => {
  engine(on)
  const ui = await mount($)
  expect(await keysOf(ui)).toEqual(['enhance', 'send', 'mode', 'peer-alone'])
  await ui.unmount()
})

test('A survey holds the band: the row yields and the drawing beneath is passed on untouched', async ($, on) => {
  engine(on)
  const ui = await mount($, { ...PROPS, hasSurvey: true })
  expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  await ui.unmount()
})

test('A survey yields beside a composing peer too: only the peer shows', { plugins: [composingPeer('prepend')] }, async ($, on) => {
  engine(on)
  const ui = await mount($, { ...PROPS, hasSurvey: true })
  expect(await keysOf(ui)).toEqual(['peer-row'])
  await ui.unmount()
})
