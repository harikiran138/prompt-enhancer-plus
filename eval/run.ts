// Live comparison of v0.3.0 and v0.4.0 on the golden set, through the real model.
// Run from the mod folder: bun eval/run.ts [heldout|dev|all] [limit]
// Each call is an isolated `claude -p --model sonnet` (no tools, hooks, plugins, MCP or settings),
// so it spends the account's usage: about $0.03 to $0.05 a call.
import { $ as sh } from 'bun'
import {
  DEFAULT_SETTINGS,
  analysisRequest,
  assemble,
  evaluate,
  extractPrompt,
  parseAnalysis,
  revisionRequest,
  route,
  skillCandidates,
  substantive,
  verifySkills,
} from '../hooks/core'
import type { Analysis, SkillInfo } from '../hooks/core'
import { GOLDEN } from '../tests/golden/prompts'
import type { GoldenCase } from '../tests/golden/prompts'

const split = (process.argv[2] ?? 'heldout') as 'heldout' | 'dev' | 'all'
const limit = Number(process.argv[3] ?? 1000)
const CONCURRENCY = 6
const CONTEXT = ''

type Call = { text: string; ms: number; cost: number }

async function claude(prompt: string): Promise<Call> {
  const proc = Bun.spawn(
    ['claude', '-p', '--model', 'sonnet', '--tools', '', '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--output-format', 'json'],
    { stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe', cwd: '/tmp' },
  )
  const out = await new Response(proc.stdout).text()
  await proc.exited
  try {
    const j = JSON.parse(out)
    return { text: String(j.result ?? ''), ms: Number(j.duration_ms ?? 0), cost: Number(j.total_cost_usd ?? 0) }
  } catch {
    return { text: '', ms: 0, cost: 0 }
  }
}

// The installed skills, as this machine has them: ~/.claude/skills/<name>/SKILL.md.
async function localSkills(): Promise<SkillInfo[]> {
  const home = process.env.HOME!
  const names = (await sh`ls ${home}/.claude/skills`.quiet().text()).split('\n').filter(Boolean)
  const out: SkillInfo[] = []
  for (const name of names) {
    let description: string | undefined
    try {
      const md = await Bun.file(`${home}/.claude/skills/${name}/SKILL.md`).text()
      description = md.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '')
    } catch {
      // A folder without SKILL.md still counts by name.
    }
    out.push({ name, description })
  }
  return out
}

// v0.3.0's rules, exactly as that version sent them.
async function v3Rules(): Promise<string> {
  const src = await sh`git show c315da3:hooks/register.tsx`.quiet().text()
  return src.match(/const RULES = `([\s\S]*?)`\n/)![1]!
}

const FAMILY: Record<string, string> = {
  debugging: 'fix', fix: 'fix', documentation: 'write', write: 'write', 'security-review': 'review', review: 'review',
  'codebase-exploration': 'research', research: 'research', modernization: 'refactor', refactor: 'refactor',
  'database-migration': 'ops-deploy', 'ops-deploy': 'ops-deploy', accessibility: 'design-ui', 'design-ui': 'design-ui',
}
const family = (t: string) => FAMILY[t] ?? t

// A word counts as added only when not negated just before it ("do not deploy" is not a deploy).
const added = (text: string, word: string) =>
  [...text.matchAll(new RegExp(`(^|[^\\w])${word}([^\\w]|$)`, 'gi'))].some(m => !/\b(not|never|no|without|n't|avoid)\b[^.]{0,30}$/i.test(text.slice(Math.max(0, m.index! - 40), m.index!)))
const has = (text: string, word: string) => new RegExp(`(^|[^\\w])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`, 'i').test(text)
const keepOk = (out: string, phrase: string) => (phrase.toLowerCase().match(/[a-z0-9#.]{2,}/g) ?? []).every(w => out.toLowerCase().includes(w))
const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean).length

type Scored = {
  prompt: string
  typosFixed: number
  typos: number
  protectedKept: number
  protectedTotal: number
  keepKept: number
  keepTotal: number
  added: string[]
  skills: string[]
  skillsValid: boolean
  words: number
  heuristic: number
  ms: number
  cost: number
}

function score(c: GoldenCase, prompt: string, installed: SkillInfo[], ms: number, cost: number): Scored {
  const skillLine = prompt.match(/^Use these skills: (.+)\.$/m)?.[1]
  const skills = skillLine ? skillLine.split(/,\s*/) : []
  return {
    prompt,
    typosFixed: c.typos.filter(t => !has(prompt, t)).length,
    typos: c.typos.length,
    protectedKept: c.protected.filter(t => prompt.includes(t)).length,
    protectedTotal: c.protected.length,
    keepKept: c.keep.filter(k => keepOk(prompt, k)).length,
    keepTotal: c.keep.length,
    added: c.mustNot.filter(w => added(prompt, w) && !has(c.draft, w)),
    skills,
    skillsValid: verifySkills(skills, installed, 99).dropped.length === 0,
    words: wordsOf(prompt),
    heuristic: evaluate({ draft: c.draft, prompt, profile: 'claude', installedSkills: installed, knownPaths: [], mode: 'smart' }).score,
    ms,
    cost,
  }
}

async function runV3(c: GoldenCase, rules: string, installed: SkillInfo[]) {
  const r = await claude(`${rules}\n\n<rough_prompt>\n${c.draft}\n</rough_prompt>`)
  return score(c, extractPrompt(r.text), installed, r.ms, r.cost)
}

async function runV4(c: GoldenCase, installed: SkillInfo[]) {
  let ms = 0
  let cost = 0
  const call = async (p: string) => {
    const r = await claude(p)
    ms += r.ms
    cost += r.cost
    return r.text
  }
  const skills = skillCandidates(installed, c.draft)
  const answers: { question: string; answer: string }[] = []
  const build = () => analysisRequest({ draft: c.draft, mode: 'smart', profile: 'claude', includeSkills: true, skills, context: CONTEXT, answers })
  const analyze = async (): Promise<Analysis | undefined> => {
    const first = parseAnalysis(await call(build()))
    return first ?? parseAnalysis(await call(`${build()}\n\nYour last reply was not the JSON object asked for. Reply with that JSON object only.`))
  }
  let a = await analyze()
  if (!a) return { ...score(c, '', installed, ms, cost), asked: false, questions: [] as string[], route: 'invalid', taskTypes: [] as string[], revised: false, issues: [] as string[] }
  const firstRoute = route(a, DEFAULT_SETTINGS, c.draft)
  const asked: string[] = []
  // The simulated author takes the recommended option, else the first; one round at most here.
  const pick = a.questions.find(q => q.critical || firstRoute === 'require')
  if ((firstRoute === 'ask' || firstRoute === 'require') && pick) {
    const q = pick
    asked.push(`${q.question} [${q.options.join(' | ')}]`)
    answers.push({ question: q.question, answer: q.options[q.recommended ?? 0]! })
    a = (await analyze()) ?? a
  }
  const conf = Math.min(...Object.values(a.confidence))
  const assumptions = conf < DEFAULT_SETTINGS.assumeBelow ? a.assumptions.slice(0, 5) : []
  const kept = verifySkills(a.skills, installed, 3).kept.filter(k => skills.names.includes(k))
  let prompt = assemble(a.prompt, { profile: 'claude', skills: kept, assumptions })
  const evalArgs = { draft: c.draft, analysis: a, answers: answers.map(x => x.answer), profile: 'claude' as const, installedSkills: installed, knownPaths: [], mode: 'smart' as const }
  const first = evaluate({ ...evalArgs, prompt })
  let revised = false
  if (substantive(first).length) {
    const fixed = assemble(extractPrompt(await call(revisionRequest(a, a.prompt, substantive(first).map(i => i.detail), 'claude', c.draft))), { profile: 'claude', skills: kept, assumptions })
    if (evaluate({ ...evalArgs, prompt: fixed }).score > first.score) {
      prompt = fixed
      revised = true
    }
  }
  return { ...score(c, prompt, installed, ms, cost), asked: asked.length > 0, questions: asked, route: firstRoute, taskTypes: a.taskTypes, revised, issues: first.issues.map(i => i.detail) }
}

// Blind pairwise judgement, order randomised per case.
async function judge(c: GoldenCase, p3: string, p4: string) {
  const flip = Math.random() < 0.5
  const [A, B] = flip ? [p4, p3] : [p3, p4]
  const r = await claude(`You judge prompt rewrites. An author wrote a rough prompt for a coding agent; two rewrites follow. Judge which rewrite a coding agent would execute better while staying faithful to the author: same intent and scope, nothing important lost, no invented requirements, files or actions, correct spelling, clear and actionable, no needless length. An assumptions list labelled as guesses is a disclosed guess, not an invented requirement.

<rough_prompt>
${c.draft}
</rough_prompt>

<rewrite_a>
${A}
</rewrite_a>

<rewrite_b>
${B}
</rewrite_b>

Reply with JSON only: {"winner": "a" | "b" | "tie", "a_invents": true|false, "b_invents": true|false, "reason": "one sentence"}`)
  const j = (() => {
    try {
      return JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1))
    } catch {
      return { winner: 'tie', a_invents: false, b_invents: false, reason: 'unparsed' }
    }
  })()
  const map = (w: string) => (w === 'tie' ? 'tie' : (w === 'a') !== flip ? 'v3' : 'v4')
  return {
    winner: map(String(j.winner)),
    v3Invents: Boolean(flip ? j.b_invents : j.a_invents),
    v4Invents: Boolean(flip ? j.a_invents : j.b_invents),
    reason: String(j.reason ?? ''),
    cost: r.cost,
  }
}

async function pool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await f(items[i]!, i)
        process.stderr.write(`.`)
      }
    }),
  )
  return out
}

const cases = GOLDEN.filter(c => split === 'all' || c.split === split).slice(0, limit)
const installed = await localSkills()
const rules = await v3Rules()
console.error(`${cases.length} cases, ${installed.length} skills`)
const rows = await pool(cases, CONCURRENCY, async c => {
  const [v3, v4] = await Promise.all([runV3(c, rules, installed), runV4(c, installed)])
  // Skills are measured on their own; the judge compares the prompt bodies.
  const body = (p: string) => p.replace(/^Use these skills: .+\.\n\n/, '')
  const j = await judge(c, body(v3.prompt), body(v4.prompt))
  return { id: c.id, draft: c.draft, expected: { task: c.task, shouldAsk: c.shouldAsk, risk: c.risk }, v3, v4, judge: j }
})
console.error('')

const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0)
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a')
const shouldAsk = rows.filter(r => r.expected.shouldAsk)
const shouldNot = rows.filter(r => !r.expected.shouldAsk)
const summary = {
  cases: rows.length,
  typosFixed: { v3: pct(sum(r => r.v3.typosFixed), sum(r => r.v3.typos)), v4: pct(sum(r => r.v4.typosFixed), sum(r => r.v4.typos)) },
  protectedKept: { v3: pct(sum(r => r.v3.protectedKept), sum(r => r.v3.protectedTotal)), v4: pct(sum(r => r.v4.protectedKept), sum(r => r.v4.protectedTotal)) },
  constraintsKept: { v3: pct(sum(r => r.v3.keepKept), sum(r => r.v3.keepTotal)), v4: pct(sum(r => r.v4.keepKept), sum(r => r.v4.keepTotal)) },
  unaskedActionsAdded: { v3: sum(r => r.v3.added.length), v4: sum(r => r.v4.added.length) },
  promptsNamingSkills: { v3: sum(r => (r.v3.skills.length ? 1 : 0)), v4: sum(r => (r.v4.skills.length ? 1 : 0)) },
  invalidSkillNames: { v3: sum(r => (r.v3.skillsValid ? 0 : 1)), v4: sum(r => (r.v4.skillsValid ? 0 : 1)) },
  taskFamilyMatch: pct(sum(r => (r.v4.taskTypes.some(t => family(t) === family(r.expected.task)) ? 1 : 0)), rows.length),
  primaryTaskMatch: pct(sum(r => (r.v4.taskTypes[0] && family(r.v4.taskTypes[0]) === family(r.expected.task) ? 1 : 0)), rows.length),
  askRecall: pct(shouldAsk.filter(r => r.v4.asked).length, shouldAsk.length),
  unnecessaryQuestionRate: pct(shouldNot.filter(r => r.v4.asked).length, shouldNot.length),
  revisions: sum(r => (r.v4.revised ? 1 : 0)),
  invalidReplies: sum(r => (r.v4.route === 'invalid' ? 1 : 0)),
  medianWords: { v3: median(rows.map(r => r.v3.words)), v4: median(rows.map(r => r.v4.words)) },
  heuristicMean: { v3: Math.round(sum(r => r.v3.heuristic) / rows.length), v4: Math.round(sum(r => r.v4.heuristic) / rows.length) },
  latencyMedianMs: { v3: median(rows.map(r => r.v3.ms)), v4: median(rows.map(r => r.v4.ms)) },
  costUsd: { v3: +sum(r => r.v3.cost).toFixed(2), v4: +sum(r => r.v4.cost).toFixed(2), judge: +sum(r => r.judge.cost).toFixed(2) },
  judge: {
    v4Wins: sum(r => (r.judge.winner === 'v4' ? 1 : 0)),
    v3Wins: sum(r => (r.judge.winner === 'v3' ? 1 : 0)),
    ties: sum(r => (r.judge.winner === 'tie' ? 1 : 0)),
    v3Invents: sum(r => (r.judge.v3Invents ? 1 : 0)),
    v4Invents: sum(r => (r.judge.v4Invents ? 1 : 0)),
  },
}
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)]! : 0
}

const stamp = `${new Date().toISOString().slice(0, 10)}-${(await sh`git rev-parse --short HEAD`.quiet().text()).trim()}`
await Bun.write(`eval/results/${split}-${stamp}.json`, JSON.stringify({ summary, rows }, null, 1))
console.log(JSON.stringify(summary, null, 1))
