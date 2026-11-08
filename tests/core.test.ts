import { expect, test } from 'claude-code/testing'
import {
  DEFAULT_SETTINGS,
  assemble,
  detectProfile,
  evaluate,
  localRisk,
  parseAnalysis,
  protectedTokens,
  redactSecrets,
  route,
  skillCandidates,
  strategiesFor,
  substantive,
  verifySkills,
} from '../hooks/core'
import type { Analysis, EvalInput } from '../hooks/core'
import { GOLDEN } from './golden/prompts'

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    corrected: '',
    primaryIntent: '',
    secondaryIntents: [],
    taskTypes: ['fix'],
    desiredOutcome: '',
    targetArtifact: '',
    observedContext: [],
    explicitRequirements: [],
    inferredRequirements: [],
    prohibited: [],
    assumptions: [],
    missing: [],
    risks: [],
    risk: 'low',
    confidence: { intent: 0.9, scope: 0.9, target: 0.9, behavior: 0.9 },
    skills: [],
    questions: [],
    verification: [],
    prompt: 'x',
    ...over,
  }
}
const Q = [{ question: 'Which?', options: ['A', 'B'], critical: true }]
const conf = (n: number) => ({ intent: n, scope: n, target: n, behavior: n })

test('Golden: every exact token the set marks is protected', async () => {
  const misses: string[] = []
  for (const c of GOLDEN) {
    const got = protectedTokens(c.draft)
    for (const t of c.protected) if (!got.some(g => g === t || g.includes(t))) misses.push(`${c.id}: ${t}`)
  }
  expect(misses).toEqual([])
})

// Tuned on the dev half; the held-out half is checked to a looser bar, so tuning cannot hide in it.
test('Golden: the local risk floor catches most high-risk drafts without flagging most safe ones', async () => {
  for (const [split, minCaught, maxFlagged] of [['dev', 0.9, 0.1], ['heldout', 0.75, 0.15]] as const) {
    const cases = GOLDEN.filter(c => c.split === split)
    const high = cases.filter(c => c.risk === 'high')
    const low = cases.filter(c => c.risk === 'low')
    const caught = high.filter(c => localRisk(c.draft) === 'high').length / high.length
    const flagged = low.filter(c => localRisk(c.draft) === 'high').length / low.length
    expect(caught).toBeGreaterThanOrEqual(minCaught)
    expect(flagged).toBeLessThanOrEqual(maxFlagged)
  }
})

test('Golden: the set has 100 cases, split evenly, with asks and risks in both halves', async () => {
  expect(GOLDEN.length).toBe(100)
  const held = GOLDEN.filter(c => c.split === 'heldout')
  expect(held.length).toBe(50)
  expect(held.some(c => c.shouldAsk)).toBe(true)
  expect(held.some(c => c.risk === 'high')).toBe(true)
  expect(new Set(GOLDEN.map(c => c.task)).size).toBeGreaterThanOrEqual(20)
})

test('Model detection maps names to profiles and unknowns to universal', async () => {
  expect(detectProfile('claude-opus-5-5')).toBe('claude')
  expect(detectProfile('sonnet')).toBe('claude')
  expect(detectProfile('gpt-5')).toBe('gpt')
  expect(detectProfile('o3-mini')).toBe('reasoning')
  expect(detectProfile('gemini-2.5-pro')).toBe('gemini')
  expect(detectProfile('llama-3.1-70b')).toBe('universal')
  expect(detectProfile(undefined)).toBe('universal')
})

test('Routing: sure proceeds, medium assumes, low asks, risky asks, quick never asks, no question never asks', async () => {
  const s = DEFAULT_SETTINGS
  expect(route(analysis({ confidence: conf(0.9), questions: Q }), s, 'add x')).toBe('proceed')
  expect(route(analysis({ confidence: conf(0.6), questions: Q, assumptions: ['a'] }), s, 'add x')).toBe('assume')
  expect(route(analysis({ confidence: conf(0.3), questions: Q }), s, 'add x')).toBe('ask')
  // A low-confidence question that would only polish the result is not asked.
  expect(route(analysis({ confidence: conf(0.3), questions: [{ ...Q[0]!, critical: false }] }), s, 'add x')).toBe('proceed')
  expect(route(analysis({ confidence: conf(0.5), questions: Q }), s, 'delete prod users')).toBe('require')
  expect(route(analysis({ confidence: conf(0.2), questions: Q }), { ...s, mode: 'quick' }, 'x')).toBe('proceed')
  expect(route(analysis({ confidence: conf(0.2), questions: [] }), s, 'x')).toBe('proceed')
  expect(route(analysis({ confidence: conf(0.6), questions: Q }), { ...s, mode: 'deep' }, 'add x')).toBe('ask')
  // Thresholds are settings.
  expect(route(analysis({ confidence: conf(0.35), questions: Q }), { ...s, askBelow: 0.3 }, 'add x')).toBe('proceed')
})

test('Parsing tolerates fences and gaps, rejects non-JSON and a missing prompt', async () => {
  const fenced = '```json\n{"prompt":"Do it.","taskTypes":["Design UI","nonsense"],"confidence":{"intent":7},"questions":[{"question":"Q?","options":["a","b","c","d","e"],"recommended":9}]}\n```'
  const a = parseAnalysis(fenced)!
  expect(a.prompt).toBe('Do it.')
  expect(a.taskTypes).toEqual(['design-ui'])
  expect(a.confidence.intent).toBe(1)
  expect(a.confidence.scope).toBe(0.5)
  expect(a.questions[0]!.options.length).toBe(4)
  expect(a.questions[0]!.recommended).toBeUndefined()
  expect(a.risk).toBe('medium')
  expect(parseAnalysis('no json here')).toBeUndefined()
  expect(parseAnalysis('{"corrected":"x"}')).toBeUndefined()
  expect(parseAnalysis('{"prompt": "a", broken')).toBeUndefined()
})

test('Skill verification keeps installed names, in their own spelling, up to the cap', async () => {
  const installed = [{ name: 'debugging-root-cause' }, { name: 'testing-strategy' }, { name: 'ui-review' }, { name: 'tdd' }]
  expect(verifySkills(['Debugging-Root-Cause', '/testing-strategy', 'invented', 'ui-review', 'tdd'], installed, 3)).toEqual({
    kept: ['debugging-root-cause', 'testing-strategy', 'ui-review'],
    dropped: ['invented'],
  })
  const { described, names } = skillCandidates([{ name: 'ui-review', description: 'review a user interface' }, { name: 'tax-prep' }], 'review my dashboard ui')
  expect(described.map(s => s.name)).toEqual(['ui-review'])
  expect(names).toEqual(['ui-review'])
  // A typo past the fourth letter still finds the skill.
  expect(skillCandidates([{ name: 'debugging-root-cause', description: 'find the cause of a failure' }], 'debuging the crash').names).toEqual(['debugging-root-cause'])
})

test('Secrets are redacted, ordinary text is not', async () => {
  const golden = GOLDEN.find(c => c.id === 'g032')!
  expect(redactSecrets(golden.draft).count).toBe(1)
  expect(redactSecrets('password: hunter2hunter2 and token=abcdefgh1234').count).toBe(2)
  expect(redactSecrets('fix the password reset flow').count).toBe(0)
  expect(redactSecrets('AKIAABCDEFGHIJKLMNOP').text).toBe('[REDACTED]')
})

test('Assembly adds the skills line first and labelled assumptions last, per profile', async () => {
  expect(assemble('Do it.', { profile: 'claude', skills: ['tdd'], assumptions: ['x'] })).toBe(
    'Use these skills: tdd.\n\nDo it.\n\n<assumptions>Assumed: x. If one is wrong, stop and ask.</assumptions>',
  )
  expect(assemble('Do it.', { profile: 'gpt', skills: [], assumptions: ['x'] })).toContain('Assumed: x. If one is wrong, stop and ask.')
  expect(assemble('Do it.', { profile: 'claude', skills: [], assumptions: [] })).toBe('Do it.')
})

const base = (prompt: string, over: Partial<EvalInput> = {}): EvalInput => ({
  draft: 'fix the bug in src/auth/login.ts, dont touch the scoring logic',
  prompt,
  analysis: analysis({ prohibited: ['dont touch the scoring logic'], explicitRequirements: ['fix the bug in src/auth/login.ts'] }),
  profile: 'claude',
  installedSkills: [{ name: 'debug' }],
  knownPaths: [],
  mode: 'smart',
  ...over,
})
const checks = (q: ReturnType<typeof evaluate>) => q.issues.map(i => i.check)

test('The checker passes a faithful prompt with no substantive issue', async () => {
  const q = evaluate(base('Fix the bug in src/auth/login.ts. Do not touch the scoring logic. Check it with the login tests.'))
  expect(substantive(q)).toEqual([])
  expect(q.score).toBeGreaterThanOrEqual(90)
})

test('The checker finds lost tokens, lost constraints, invented paths and unasked actions', async () => {
  expect(checks(evaluate(base('Fix the login bug. Do not touch the scoring logic.')))).toContain('intent')
  expect(checks(evaluate(base('Fix the bug in src/auth/login.ts.')))).toContain('constraints')
  expect(checks(evaluate(base('Fix the bug in src/auth/login.ts and src/auth/session.ts. Do not touch the scoring logic.')))).toContain('context')
  expect(checks(evaluate(base('Fix the bug in src/auth/login.ts, do not touch the scoring logic, then deploy to production.')))).toContain('risk')
})

test('The checker finds impossible criteria, unverified skills, wrong formats and verbosity', async () => {
  const ok = 'Fix the bug in src/auth/login.ts. Do not touch the scoring logic.'
  expect(checks(evaluate(base(`${ok} Guarantee zero bugs.`)))).toContain('testability')
  expect(checks(evaluate(base(`Use these skills: debug, invented.\n\n${ok}`)))).toContain('skills')
  expect(checks(evaluate(base(`<goal>${ok}</goal>`, { profile: 'gpt' })))).toContain('model')
  expect(checks(evaluate(base(`${ok} Think step by step and show your reasoning.`, { profile: 'reasoning' })))).toContain('model')
  expect(checks(evaluate(base(`${ok} ${'Also consider more details here. '.repeat(60)}`)))).toContain('conciseness')
})

test('Adding requirements never raises the score', async () => {
  const faithful = evaluate(base('Fix the bug in src/auth/login.ts. Do not touch the scoring logic. Run the login tests.'))
  const padded = evaluate(base('Fix the bug in src/auth/login.ts. Do not touch the scoring logic. Run the login tests. Also add dark mode, then publish a release.'))
  expect(padded.score).toBeLessThan(faithful.score)
})

test('strategiesFor sends only the guides the draft points at, plus the question fallback', () => {
  const fix = strategiesFor('fix the login bug, error on save')
  expect(fix).toContain('fix / debugging:')
  expect(fix).not.toContain('database-migration')
  expect(fix.split('\n').length).toBeLessThanOrEqual(4)
  expect(strategiesFor('hmm')).toContain('build:')
})
