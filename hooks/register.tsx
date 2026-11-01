import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import {
  DEFAULT_SETTINGS,
  MODES,
  PROFILES,
  analysisRequest,
  assemble,
  evaluate,
  extractPrompt,
  parseAnalysis,
  quickRequest,
  redactSecrets,
  referencedPaths,
  resolveProfile,
  revisionRequest,
  route,
  sendsHere,
  skillCandidates,
  substantive,
  verifySkills,
} from './core'
import type { Analysis, Mode, ProfileId, Question, Settings, SkillInfo, TargetSetting } from './core'
import type { EnhancerPhase, EnhancerPreview, EnhancerQuestion } from '../types'

const phase = atom({ plugin: 'prompt-enhancer-plus', key: 'phase' } as const, 'idle' as EnhancerPhase)
const step = atom({ plugin: 'prompt-enhancer-plus', key: 'step' } as const, '')
const note = atom({ plugin: 'prompt-enhancer-plus', key: 'note' } as const, null)
const question = atom({ plugin: 'prompt-enhancer-plus', key: 'question' } as const, null as EnhancerQuestion | null)
const preview = atom({ plugin: 'prompt-enhancer-plus', key: 'preview' } as const, null as EnhancerPreview | null)
const modeAtom = atom({ plugin: 'prompt-enhancer-plus', key: 'mode' } as const, 'smart' as Mode)
// Bumped by every start and every cancel: a result whose version is stale is thrown away.
const version = atom({ plugin: 'prompt-enhancer-plus', key: 'version' } as const, 0)

// Claude Code's own action for focusing plugin rows, and its built-in chord.
const FOCUS_ACTION = 'abovePrompt:focus'
const DEFAULT_FOCUS_KEY = 'ctrl+x tab'
const focusKey = atom({ plugin: 'prompt-enhancer-plus', key: 'focusKey' } as const, DEFAULT_FOCUS_KEY)

const FALLBACK_MODEL = 'sonnet'
const CALL_TIMEOUT_MS = 90_000
const CLAUDE_MD_CHARS = 2500

// Module-level, per load: the in-band answer a clarification waits on, and the running call's abort.
let answerWaiter: ((answer: string | null) => void) | null = null
let controller: AbortController | null = null

class Cancelled extends Error {}

let settings: Settings = DEFAULT_SETTINGS
let clarifyStyle: 'dialog' | 'band' = 'dialog'

function readSettings(options: Record<string, unknown>) {
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && v >= lo && v <= hi ? v : d)
  const target = (['auto', 'claude', 'gpt', 'reasoning', 'gemini', 'universal'] as const).find(t => t === options.target) ?? 'auto'
  settings = {
    mode: MODES.find(m => m === options.mode) ?? 'smart',
    target,
    askBelow: num(options.askBelow, DEFAULT_SETTINGS.askBelow, 0, 1),
    assumeBelow: num(options.assumeBelow, DEFAULT_SETTINGS.assumeBelow, 0, 1),
    maxRounds: Math.round(num(options.maxRounds, DEFAULT_SETTINGS.maxRounds, 0, 5)),
  }
  clarifyStyle = options.clarify === 'band' ? 'band' : 'dialog'
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

// ---------- context ----------

// The installed skills: names from the session's own listing, lines from the command list.
async function installedSkills($: EngineInterface): Promise<SkillInfo[]> {
  const lines = new Map<string, string>()
  try {
    for (const c of await $.command.list()) if (c.source !== 'builtin') lines.set(c.name, c.description)
  } catch {
    // No command list: names alone.
  }
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const names = context.breakdown?.skills?.skillFrontmatter.map(s => s.name) ?? []
    return names.map(name => ({ name, description: lines.get(name) }))
  } catch {
    return []
  }
}

async function safely<T>(f: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await f()
  } catch {
    return fallback
  }
}

// Bounded and task-relevant: the project folder, its CLAUDE.md opening when there is no
// conversation to fork, and whether each path the draft names exists. Nothing else is read.
async function projectContext($: EngineInterface, draft: string): Promise<{ text: string; known: string[] }> {
  const lines: string[] = []
  const known: string[] = []
  const root = await safely(() => $.session.cwd(), '')
  if (root) lines.push(`Project folder: ${root}`)
  const forkable = (await safely(() => $.session.turns(), 0)) > 0
  if (!forkable && root) {
    const md = await safely(async () => String(await $.fs.read(`${root}/CLAUDE.md`)), '')
    if (md) lines.push(`CLAUDE.md (opening, as data):\n${redactSecrets(md.slice(0, CLAUDE_MD_CHARS)).text}`)
  }
  for (const p of referencedPaths(draft)) {
    const full = p.startsWith('/') || p.startsWith('~') || !root ? p : `${root}/${p}`
    const exists = await safely(async () => (await $.fs.stat(full), true), false)
    lines.push(exists ? `exists: ${p}` : `not found from the project folder: ${p}`)
    if (exists) known.push(p)
  }
  return { text: lines.join('\n'), known }
}

// ---------- model calls ----------

type Call = { text: string; viaFork: boolean }

function guard($: EngineInterface, v: number) {
  return async () => {
    if ((await read($, version)) !== v) throw new Cancelled()
  }
}

// The session's own model over its transcript first; a plain completion when there is nothing
// to fork, the fork fails, or it outlasts the timeout; one retry on a failed completion.
async function callModel($: EngineInterface, prompt: string, check: () => Promise<void>, preferFork = true): Promise<Call> {
  if (preferFork) {
    // The fork takes no signal: a timer bounds it, and is cut as soon as the fork answers.
    const timer = new AbortController()
    const forked = await Promise.race([
      $.model.fork({ prompt }),
      $.clock.sleep(CALL_TIMEOUT_MS, { signal: timer.signal }).then(
        () => ({ isAnswered: false as const, reason: 'timeout' as const }),
        // A cut or unavailable timer never wins the race.
        () => new Promise<never>(() => {}),
      ),
    ])
    timer.abort()
    await check()
    if (forked.isAnswered) return { text: forked.text, viaFork: true }
  }
  let reason = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    controller = new AbortController()
    const done = await $.model.complete(
      { model: FALLBACK_MODEL, prompt, maxTokens: 6000, timeoutMs: CALL_TIMEOUT_MS },
      { signal: controller.signal },
    )
    await check()
    if (done.isAnswered) return { text: done.text, viaFork: false }
    reason = done.reason
    if (done.reason === 'aborted') break
  }
  throw new Error(`model call failed: ${reason}`)
}

async function analyze($: EngineInterface, request: string, check: () => Promise<void>): Promise<Analysis> {
  const parsed = parseAnalysis((await callModel($, request, check)).text)
  if (parsed) return parsed
  // One repair, then give up rather than loop.
  await update($, step, () => 'Repairing reply…')
  const repaired = parseAnalysis((await callModel($, `${request}\n\nYour last reply was not the JSON object asked for. Reply with that JSON object only.`, check, false)).text)
  if (!repaired) throw new Error('the model reply was not valid')
  return repaired
}

// ---------- clarification ----------

const RECOMMENDED = ' (Recommended)'

async function clarify($: EngineInterface, q: Question, round: number, check: () => Promise<void>): Promise<string | null> {
  if (clarifyStyle === 'dialog') {
    const labels = q.options.map((o, i) => (i === q.recommended ? `${o}${RECOMMENDED}` : o))
    let picked: string | undefined
    try {
      picked = await $.ui.ask(q.question, { options: labels, header: 'Clarify' })
    } catch {
      // No dialog here, or it was dismissed: the same question, in the band, where Skip is one key.
    }
    await check()
    if (picked !== undefined) return picked.endsWith(RECOMMENDED) ? picked.slice(0, -RECOMMENDED.length) : picked
  }
  await update($, question, () => ({ question: q.question, options: q.options, recommended: q.recommended ?? null, round, maxRounds: settings.maxRounds }))
  await update($, phase, () => 'clarifying' as EnhancerPhase)
  const answer = await new Promise<string | null>(resolve => {
    answerWaiter = resolve
  })
  answerWaiter = null
  await update($, question, () => null)
  await check()
  await update($, phase, () => 'working' as EnhancerPhase)
  return answer
}

const answerBand = (answer: string | null) => answerWaiter?.(answer)

// ---------- the enhancement ----------

type Result = { prompt: string; analysis?: Analysis; answers: string[]; assumptions: string[]; skills: string[]; dropped: string[] }

// interactive: false where nobody can answer (the /enhance command): questions are skipped, assumptions written.
async function smart($: EngineInterface, draft: string, mode: Mode, s: Settings, profile: ProfileId, includeSkills: boolean, installed: SkillInfo[], check: () => Promise<void>, interactive = true): Promise<Result> {
  const ctx = await projectContext($, draft)
  await check()
  const skills = skillCandidates(installed, draft)
  const answers: { question: string; answer: string }[] = []
  const asked = new Set<string>()
  const build = () => analysisRequest({ draft, mode, profile, includeSkills, skills, context: ctx.text, answers })
  await update($, step, () => 'Understanding the request…')
  let analysis = await analyze($, build(), check)
  let unresolved = false
  for (let round = 1; ; round++) {
    const r = route(analysis, s, draft)
    const q = analysis.questions.find(x => !asked.has(x.question.toLowerCase()))
    if ((r !== 'ask' && r !== 'require') || !q) break
    if (round > s.maxRounds) {
      unresolved = true
      break
    }
    asked.add(q.question.toLowerCase())
    const a = interactive ? await clarify($, q, round, check) : null
    if (a === null) {
      unresolved = true
      break
    }
    answers.push({ question: q.question, answer: a })
    await update($, step, () => 'Applying your answer…')
    analysis = await analyze($, build(), check)
  }
  const conf = Math.min(...Object.values(analysis.confidence))
  // Assumptions are shown, labelled and reversible, whenever the reading was not a sure one.
  const assumptions = unresolved || conf < s.assumeBelow ? analysis.assumptions.slice(0, 5) : []
  const { kept, dropped } = includeSkills ? verifySkills(analysis.skills, installed, mode === 'deep' ? 5 : 3) : { kept: [], dropped: [] }
  const shape = (body: string) => assemble(body, { profile, skills: kept, assumptions })
  const result: Result = { prompt: shape(analysis.prompt), analysis, answers: answers.map(x => x.answer), assumptions, skills: kept, dropped }

  // One bounded self-revision when the checker finds a substantive problem; keep the better one.
  const evalArgs = { draft, analysis, answers: result.answers, profile, installedSkills: installed, knownPaths: ctx.known, mode }
  const first = evaluate({ ...evalArgs, prompt: result.prompt })
  const problems = substantive(first)
  if (!problems.length) return result
  await update($, step, () => 'Checking quality…')
  try {
    const r = await callModel($, revisionRequest(analysis, analysis.prompt, problems.map(p => p.detail), profile, draft), check)
    const revised = shape(extractPrompt(r.text))
    if (evaluate({ ...evalArgs, prompt: revised }).score > first.score) result.prompt = revised
  } catch (err) {
    if (err instanceof Cancelled) throw err
    // A failed revision keeps the first rewrite.
  }
  return result
}

async function enhance($: EngineInterface, opts: { draft?: string } = {}) {
  const current = await read($, phase)
  if (current === 'working' || current === 'clarifying') return
  const box = (await $.prompt.read()).text
  const prev = await read($, preview)
  const draft = opts.draft ?? box
  if (!draft.trim()) {
    $.ui.toast('Type a prompt first')
    return
  }
  const v = (await read($, version)) + 1
  await update($, version, () => v)
  const check = guard($, v)
  const mode = await read($, modeAtom)
  const s = { ...settings, mode }
  const settle = async () => update($, phase, () => (prev ? 'preview' : 'idle') as EnhancerPhase)
  await update($, phase, () => 'working' as EnhancerPhase)
  await update($, note, () => null)
  await update($, step, () => 'Reading context…')
  try {
    const profile: ProfileId = resolveProfile(s.target, await safely(() => $.session.model(), undefined as string | undefined))
    const includeSkills = sendsHere(s.target) && mode !== 'quick'
    const installed = includeSkills ? await installedSkills($) : []
    let result: Result
    if (mode === 'quick') {
      await update($, step, () => 'Correcting…')
      const r = await callModel($, quickRequest(draft, profile), check)
      result = { prompt: extractPrompt(r.text), answers: [], assumptions: [], skills: [], dropped: [] }
    } else {
      result = await smart($, draft, mode, s, profile, includeSkills, installed, check)
    }

    const { text: safe, count: redacted } = redactSecrets(result.prompt)
    if (!safe.trim()) throw new Error('empty rewrite')
    await check()
    // The person may have kept typing; keep their newer draft rather than clobber it.
    if ((await $.prompt.read()).text !== box) {
      await update($, note, () => 'Draft changed while enhancing; rewrite discarded')
      await settle()
      return
    }
    const filled = await $.prompt.fill({ text: safe })
    if (!filled.isFilled) throw new Error(`prompt box refused (${filled.refusal ?? 'unknown'})`)
    const q = evaluate({ draft, prompt: safe, analysis: result.analysis, answers: result.answers, profile, installedSkills: installed, knownPaths: referencedPaths(draft), mode })
    await update($, preview, () => ({
      original: prev?.original ?? draft,
      enhanced: safe,
      mode,
      profile,
      task: result.analysis?.taskTypes.join(' + ') ?? 'correction',
      score: q.score,
      issues: q.issues.map(i => i.detail).slice(0, 3),
      skills: result.skills,
      dropped: result.dropped,
      assumptions: result.assumptions,
      answers: result.answers,
      redacted,
      compare: false,
    }))
    await update($, phase, () => 'preview' as EnhancerPhase)
    if (redacted) await update($, note, () => `${redacted} secret-looking value${redacted > 1 ? 's' : ''} redacted`)
  } catch (err) {
    if (err instanceof Cancelled) return
    await update($, note, () => `Enhance failed: ${err instanceof Error ? err.message : String(err)}`)
    await settle()
  } finally {
    if ((await read($, version)) === v) await update($, step, () => '')
  }
}

// /enhance <draft>: the same pipeline without the prompt box, answered as text. Nobody is asked anything.
async function enhanceCommand($: EngineInterface, draft: string): Promise<string> {
  if (!draft.trim()) return 'Usage: /enhance <rough prompt>. It prints the enhanced prompt; nothing is sent.'
  const mode = await read($, modeAtom)
  const s = { ...settings, mode }
  const check = async () => {}
  const profile: ProfileId = resolveProfile(s.target, await safely(() => $.session.model(), undefined as string | undefined))
  const includeSkills = sendsHere(s.target) && mode !== 'quick'
  const installed = includeSkills ? await installedSkills($) : []
  try {
    const result: Result =
      mode === 'quick'
        ? { prompt: extractPrompt((await callModel($, quickRequest(draft, profile), check)).text), answers: [], assumptions: [], skills: [], dropped: [] }
        : await smart($, draft, mode, s, profile, includeSkills, installed, check, false)
    const { text: safe, count: redacted } = redactSecrets(result.prompt)
    const q = evaluate({ draft, prompt: safe, analysis: result.analysis, answers: [], profile, installedSkills: installed, knownPaths: referencedPaths(draft), mode })
    const facts = [
      MODE_LABEL[mode],
      result.analysis?.taskTypes.join(' + ') ?? 'correction',
      `${PROFILES[profile].label} profile`,
      `quality ${q.score}/100`,
      `${installed.length} skills installed`,
      result.skills.length ? `named: ${result.skills.join(', ')}` : 'no skills named',
      result.dropped.length ? `left out (not installed): ${result.dropped.join(', ')}` : '',
      result.analysis ? `confidence ${Math.min(...Object.values(result.analysis.confidence)).toFixed(2)}, risk ${result.analysis.risk}, route ${route(result.analysis, s, draft)}` : '',
      result.analysis?.questions[0] ? `would ask: ${result.analysis.questions[0].question} [${result.analysis.questions[0].options.join(' | ')}]` : '',
      redacted ? `${redacted} secret(s) redacted` : '',
    ].filter(Boolean)
    return `${safe}\n\n— ${facts.join(' · ')}`
  } catch (err) {
    return `Enhance failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function cancel($: EngineInterface) {
  await update($, version, n => n + 1)
  controller?.abort()
  answerBand(null)
  await update($, question, () => null)
  await update($, step, () => '')
  await update($, note, () => 'Enhance cancelled; draft unchanged')
  const hasPreview = (await read($, preview)) !== null
  await update($, phase, () => (hasPreview ? 'preview' : 'idle') as EnhancerPhase)
}

async function restore($: EngineInterface) {
  const p = await read($, preview)
  if (!p) return
  await $.prompt.fill({ text: p.original })
  await update($, preview, () => null)
  await update($, phase, () => 'idle' as EnhancerPhase)
  await update($, note, () => 'Original restored')
}

async function accept($: EngineInterface) {
  await update($, preview, () => null)
  await update($, note, () => null)
  await update($, phase, () => 'idle' as EnhancerPhase)
}

async function retry($: EngineInterface) {
  const p = await read($, preview)
  if (p) await enhance($, { draft: p.original })
}

async function cycleMode($: EngineInterface) {
  const now = await read($, modeAtom)
  const next = MODES[(MODES.indexOf(now) + 1) % MODES.length]!
  await update($, modeAtom, () => next)
  await safely(() => $.store.set('mode', next), undefined)
}

async function send($: EngineInterface) {
  const { text } = await $.prompt.read()
  if (!text.trim()) {
    $.ui.toast('Nothing to send')
    return
  }
  await $.prompt.fill({ text: '' })
  await update($, note, () => null)
  await update($, preview, () => null)
  await update($, phase, () => 'idle' as EnhancerPhase)
  // asUser: the model reads it as the person's own words, not framed as a plugin message.
  await $.prompt.submit({ text, asUser: true })
}

const MODE_LABEL: Record<Mode, string> = { quick: 'Quick', smart: 'Smart', deep: 'Deep' }

export const register: Register = (on, options) => {
  readSettings((options ?? {}) as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const chord = await readFocusKey($)
    await update($, focusKey, () => chord)
    const stored = await safely(() => $.store.get('mode'), undefined)
    await update($, modeAtom, () => MODES.find(m => m === stored) ?? settings.mode)
    await safely(() => $.command.register({ name: 'enhance', description: 'Rewrite a rough prompt with Prompt Enhancer++ and print it (sends nothing)' }), undefined)
    return next(e)
  })

  on('command.run', { command: 'enhance' }, async ($, e) => ({ text: await enhanceCommand($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The row stays during a running turn: Enhance forks without touching it, and Send queues behind it.
    // A survey holds the band: yield to it.
    if (e.props.hasSurvey) return next(e)

    // Compose: this row, and beneath it whatever the rest of the chain drew (another plugin's band, the engine's).
    const below = await next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile app draws no field: there the numbered choices and Skip remain.
    const Input = 'Input' in elements ? elements.Input : undefined
    const now = await read($, phase)
    const message = await read($, note)
    const chord = await read($, focusKey)
    const mode = await read($, modeAtom)
    const target: TargetSetting = settings.target
    const terminal = e.surface === 'terminal'
    const sendLabel = e.props.isWorking ? 's queue' : 's send'
    const modeButton = <Button key="mode" label={`Mode: ${MODE_LABEL[mode]}`} hotkey="m" onPress={() => cycleMode($)} />
    const targetText = target === 'auto' ? '' : ` · for ${PROFILES[target].label}`

    let body
    if (now === 'working') {
      const label = (await read($, step)) || 'Enhancing…'
      body = (
        <Box>
          <Text dimColor>{label} </Text>
          <Button key="cancel" label="Cancel" hotkey="x" onPress={() => cancel($)} />
        </Box>
      )
    } else if (now === 'clarifying') {
      const q = await read($, question)
      body = q ? (
        <Box flexDirection="column">
          <Text>
            {q.question} <Text dimColor>({q.round}/{q.maxRounds})</Text>
          </Text>
          <Box>
            {q.options.map((o, i) => (
              <Box key={`opt-${i}`}>
                <Button key={`answer-${i + 1}`} label={`${i + 1}. ${o}${i === q.recommended ? ' ★' : ''}`} hotkey={String(i + 1)} onPress={() => answerBand(o)} />
                <Text> </Text>
              </Box>
            ))}
            <Button key="skip" label="Skip" hotkey="k" onPress={() => answerBand(null)} />
            <Text> </Text>
            <Button key="cancel" label="Cancel" hotkey="x" onPress={() => cancel($)} />
          </Box>
          {Input ? <Input key="custom" label="Other: " placeholder="type your own answer, Enter to use it" onSubmit={(v: string) => void (v.trim() && answerBand(v.trim()))} /> : null}
          {terminal ? <Text dimColor>1-{q.options.length} choose · k skip · x cancel · ★ recommended</Text> : null}
        </Box>
      ) : null
    } else if (now === 'preview') {
      const p = await read($, preview)
      const summary = p
        ? [
            MODE_LABEL[p.mode],
            p.task,
            PROFILES[p.profile].label,
            `quality ${p.score}/100`,
            p.skills.length ? `skills: ${p.skills.join(', ')}` : '',
            p.assumptions.length ? `${p.assumptions.length} assumption${p.assumptions.length > 1 ? 's' : ''}` : '',
          ].filter(Boolean).join(' · ')
        : ''
      const hint = [chord, 'a accept', 'c compare', 't retry', 'r restore', 'e enhance', sendLabel, 'esc back'].filter(Boolean).join(' · ')
      body = (
        <Box flexDirection="column">
          <Box>
            <Button key="accept" label="Accept" hotkey="a" variant="primary" onPress={() => accept($)} />
            <Text> </Text>
            <Button key="compare" label={p?.compare ? 'Hide original' : 'Compare'} hotkey="c" onPress={() => update($, preview, x => (x ? { ...x, compare: !x.compare } : x))} />
            <Text> </Text>
            <Button key="retry" label="Retry" hotkey="t" onPress={() => void retry($)} />
            <Text> </Text>
            <Button key="restore" label="Restore original" hotkey="r" onPress={() => restore($)} />
            <Text> </Text>
            <Button key="enhance" label="Enhance" hotkey="e" onPress={() => void enhance($)} />
            <Text> </Text>
            <Button key="send" label="Send" hotkey="s" onPress={() => send($)} />
            <Text> </Text>
            {modeButton}
          </Box>
          <Text dimColor>{summary}</Text>
          {p?.compare ? (
            <Box flexDirection="column">
              <Text dimColor>Original: {p.original.split('\n').slice(0, 3).join(' ⏎ ').slice(0, 300)}</Text>
              {p.answers.length ? <Text dimColor>Your answers: {p.answers.join(' · ')}</Text> : null}
              {p.assumptions.length ? <Text dimColor>Assumptions: {p.assumptions.join(' · ').slice(0, 300)}</Text> : null}
              {p.dropped.length ? <Text dimColor>Not installed, left out: {p.dropped.join(', ')}</Text> : null}
              {p.issues.length ? <Text dimColor>Checker: {p.issues.join(' · ').slice(0, 300)}</Text> : null}
            </Box>
          ) : null}
          {terminal ? <Text dimColor>{hint}</Text> : null}
        </Box>
      )
    } else {
      const hint = [chord, 'e enhance', sendLabel, 'm mode', 'esc back'].filter(Boolean).join(' · ')
      body = (
        <Box>
          {/* Not awaited: a rewrite can outlast the 10s ui.press budget; the phase guards re-entry. */}
          <Button key="enhance" label="Enhance" hotkey="e" variant="primary" onPress={() => void enhance($)} />
          <Text> </Text>
          <Button key="send" label="Send" hotkey="s" onPress={() => send($)} />
          <Text> </Text>
          {modeButton}
          {/* The focus chord is a terminal keybinding; other surfaces click. */}
          {terminal ? <Text dimColor>  {hint}</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Prompt enhancer++{targetText} </Text>
          {body}
        </Box>
        {message ? <Text dimColor> {message}</Text> : null}
        {below}
      </Box>
    )
  })
}
