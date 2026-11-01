import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isBusy = atom({ plugin: 'prompt-enhancer-plus', key: 'isBusy' } as const, false)
const note = atom({ plugin: 'prompt-enhancer-plus', key: 'note' } as const, null)

// Claude Code's own action for focusing plugin rows, and its built-in chord.
const FOCUS_ACTION = 'abovePrompt:focus'
const DEFAULT_FOCUS_KEY = 'ctrl+x tab'
const focusKey = atom({ plugin: 'prompt-enhancer-plus', key: 'focusKey' } as const, DEFAULT_FOCUS_KEY)

const FALLBACK_MODEL = 'sonnet'

// Written to Anthropic's prompting guidance for current Claude models: explicit instructions,
// the reason behind each constraint, XML-tagged sections, success criteria, and calm wording
// (no ALL-CAPS or "MUST"), since newer models follow instructions closely and overreact to emphasis.
const RULES = `Goal: rewrite the rough prompt below into a clear, complete prompt that a coding agent in this project can act on from start to finish. The author types fast, so the draft often has typos, broken grammar and missing structure; your job is to fix all of that and turn it into the best prompt for its kind of task.

Do these steps in order:

1. Correct the text. Fix every spelling, typo, grammar and punctuation error, and turn broken phrasing into plain, correct sentences. Read through the typos to the meaning the author intended ("cployt thgive" in a sentence about skills means "Claude might need"). Keep code, file names, paths, commands, identifiers, URLs, version numbers and quoted text exactly as written, because changing them would break them.

2. Keep the author's intent. Every requirement comes from what they asked for or clearly implied. Add no new features or scope. Keep their language: if they wrote in English, answer in English.

3. Classify the task as one of: build, fix, review, research, write, refactor, data/analysis, design/UI, ops/deploy, or question. Then structure the rewrite with the matching template below. Use only the sections that carry real content; leave a section out rather than fill it with guesses.

<templates>
build: <task> what to build and why · <context> project, stack, files involved · <requirements> concrete behaviour, as bullets · <constraints> what to keep unchanged, conventions to follow · <done_when> tests or checks that prove it works
fix: <problem> what is wrong, with the exact error or symptom · <expected> correct behaviour · <context> where it happens, steps to reproduce · <approach> find the root cause before changing code; add a test that fails before the fix and passes after · <done_when>
review: <scope> what to review (files, diff, PR) · <focus> what to check: correctness, security, performance, style · <output> findings ranked by severity, each with file:line and a suggested fix
research: <question> the exact question · <scope> sources, time range, depth · <output> answer first, then evidence, with sources cited
write: <task> the document and its purpose · <audience> who reads it · <tone_and_length> · <must_cover> key points · <output> format
refactor: <task> what to restructure and why · <constraints> behaviour must not change; existing tests must keep passing · <done_when>
data/analysis: <data> sources and their shape · <question> what to find out · <output> tables, charts or numbers wanted, with the method stated
design/UI: <task> screen or component · <users_and_goal> · <requirements> layout, states, accessibility, responsiveness · <done_when> how to check it visually
ops/deploy: <task> · <environment> · <safety> confirm before anything destructive or irreversible; how to roll back · <done_when>
question: one clear question with the context needed to answer it; no template sections.
</templates>

4. Pick skills. From the installed skills listed in <installed_skills> (and any skill listing in the conversation), choose the 1 to 3 that best fit this task, and add one line near the top: "Use these skills: name-a, name-b." Name only skills that appear in that list, spelled exactly as listed, because a made-up name would fail to load. If none fits, leave the line out. Keep any skill, plugin or command the author named themselves.

5. Fit the project. Use only paths and facts that the project folder, its files, CLAUDE.md or the conversation show. Do not invent file names or APIs.

6. Write it in the author's voice, as a direct instruction to the agent ("Add…", "Find…"), not as a request for suggestions, because a vague ask gets suggestions instead of action. Match length to the request: a one-line ask becomes a short prompt with a few tagged sections, not a page. Every added line carries a fact the agent needs.

Reply with the rewritten prompt only, wrapped in <prompt></prompt>. Stop after </prompt>.`

const extract = (reply: string) => {
  return (reply.match(/<prompt>([\s\S]*?)<\/prompt>/)?.[1] ?? reply).trim()
}

async function fallbackContext($: EngineInterface): Promise<string> {
  return `Project folder: ${await $.session.cwd()}`
}

// The skill names the session lists for the model, so the rewrite can name ones that exist.
// Names only: descriptions for hundreds of skills would crowd out the draft.
async function installedSkills($: EngineInterface): Promise<string> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const names = context.breakdown?.skills?.skillFrontmatter.map(s => s.name) ?? []
    return names.length ? names.join(', ') : '(none listed)'
  } catch {
    return '(none listed)'
  }
}

// The chord that focuses the row, as the user's keybindings.json has it: their own
// Chat binding of abovePrompt:focus first, else the built-in chord unless they rebound it.
async function readFocusKey($: EngineInterface): Promise<string | null> {
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const chat: Record<string, string | null> = {}
  try {
    const file = JSON.parse(String(await $.fs.read(`${dir}/keybindings.json`)))
    for (const block of file.bindings ?? []) {
      if (block.context !== 'Chat') continue
      for (const [chord, action] of Object.entries(block.bindings ?? {})) chat[chord.toLowerCase()] = action as string | null
    }
  } catch {
    // No keybindings.json, or one that doesn't parse: Claude Code uses its defaults.
  }
  const own = Object.keys(chat).find(chord => chat[chord] === FOCUS_ACTION)
  if (own) return own
  return DEFAULT_FOCUS_KEY in chat ? null : DEFAULT_FOCUS_KEY
}

async function rewrite($: EngineInterface, draft: string): Promise<string> {
  const ask = `${RULES}\n\n<installed_skills>\n${await installedSkills($)}\n</installed_skills>\n\n<rough_prompt>\n${draft}\n</rough_prompt>`
  const forked = await $.model.fork({ prompt: ask })
  if (forked.isAnswered) return extract(forked.text)
  if (forked.reason !== 'nothing-to-fork') throw new Error(`model call failed: ${forked.reason}`)

  // No conversation to fork yet (fresh session): ask without the session's context.
  const done = await $.model.complete({
    model: FALLBACK_MODEL,
    system: await fallbackContext($),
    prompt: ask,
    maxTokens: 6000,
    timeoutMs: 120_000,
  })
  if (!done.isAnswered) throw new Error(`model call failed: ${done.reason}`)
  return extract(done.text)
}

async function enhance($: EngineInterface) {
  if (await read($, isBusy)) return
  const { text } = await $.prompt.read()
  if (!text.trim()) {
    $.ui.toast('Type a prompt first')
    return
  }
  await update($, isBusy, () => true)
  await update($, note, () => null)
  try {
    const better = await rewrite($, text)
    if (!better) throw new Error('empty rewrite')
    // The person may have kept typing; keep their newer draft rather than clobber it.
    if ((await $.prompt.read()).text !== text) {
      await update($, note, () => 'Draft changed while enhancing; rewrite discarded')
      return
    }
    const filled = await $.prompt.fill({ text: better })
    if (!filled.isFilled) throw new Error(`prompt box refused (${filled.refusal ?? 'unknown'})`)
  } catch (err) {
    await update($, note, () => `Enhance failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, isBusy, () => false)
  }
}

async function send($: EngineInterface) {
  const { text } = await $.prompt.read()
  if (!text.trim()) {
    $.ui.toast('Nothing to send')
    return
  }
  await $.prompt.fill({ text: '' })
  await update($, note, () => null)
  // asUser: the model reads it as the person's own words, not framed as a plugin message.
  await $.prompt.submit({ text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const chord = await readFocusKey($)
    await update($, focusKey, () => chord)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The row stays during a running turn: Enhance forks without touching it, and Send queues behind it.
    // A survey holds the band: yield to it.
    if (e.props.hasSurvey) return next(e)

    // Compose: this row, and beneath it whatever the rest of the chain drew (another plugin's band, the engine's).
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const busy = await read($, isBusy)
    const message = await read($, note)
    const chord = await read($, focusKey)
    // esc is Claude Code's built-in abovePrompt:leave chord: it returns focus to the prompt box.
    const hint = [chord, 'e enhance', e.props.isWorking ? 's queue' : 's send', 'esc back'].filter(Boolean).join(' · ')

    const row = (
      <Box>
        <Text dimColor>Prompt enhancer+ </Text>
        {busy ? (
          <Text dimColor>
            Enhancing…
          </Text>
        ) : (
          <Box>
            {/* Not awaited: a rewrite can outlast the 10s ui.press budget; isBusy guards re-entry. */}
            <Button key="enhance" label="Enhance" hotkey="e" variant="primary" onPress={() => void enhance($)} />
            <Text> </Text>
            <Button key="send" label="Send" hotkey="s" onPress={() => send($)} />
            {/* The focus chord is a terminal keybinding; other surfaces click. */}
            {e.surface === 'terminal' ? <Text dimColor>  {hint}</Text> : null}
          </Box>
        )}
        {message ? (
          <Text dimColor>
            {' '}
            {message}
          </Text>
        ) : null}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
