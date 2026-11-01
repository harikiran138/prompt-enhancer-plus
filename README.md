# Prompt Enhancer++ (prompt-enhancer-plus 0.4.0)

A Claude Code mod that turns a rough, typo-filled prompt into a clear, executable one, in place, before you send it. It reads what you actually want, fixes the spelling and grammar, asks a question only when the answer would change the work, names installed skills that fit, and writes the prompt for the model that will read it. It never sends anything itself.

```
Prompt enhancer++ [ Enhance ] [ Send ] [ Mode: Smart ]  ctrl+x tab · e enhance · s send · m mode · esc back
────────────────────────────────────────────────────────────────────
❯ fix teh login bug its not workng when pasword has speical charcters
```

## Use it

1. Type a draft in the prompt box.
2. Focus the row with the chord it shows (`ctrl+x tab` by default; see [Focus chord](#focus-chord)), or click.
3. Press `e`. The row shows each step (`Understanding the request…`) with a **Cancel** (`x`) button.
4. If a question comes up, answer it (see [Clarification](#clarification)).
5. The rewrite lands in the prompt box, and the row switches to its preview controls.
6. Read it, edit it if you like, and press `s` or Enter to send.

### Keys

| Row state | Keys |
|---|---|
| Idle | `e` enhance · `s` send (`s queue` while a turn runs) · `m` cycle mode · `Esc` back to the box |
| Working | `x` cancel (the draft stays as typed) |
| Question in the row | `1`–`4` choose (★ marks the recommended one) · type in **Other** and Enter · `k` skip · `x` cancel |
| Preview | `a` accept · `c` compare · `t` retry · `r` restore original · `e` enhance again · `s` send · `m` mode |

- **Accept** keeps the rewrite and clears the preview row.
- **Compare** shows the original draft, your answers, the assumptions, any skills left out because they are not installed, and the checker's notes.
- **Retry** rewrites the original draft again.
- **Restore original** puts your draft back.

**`/enhance <draft>`** runs the same pipeline and prints the enhanced prompt with its facts (mode, task, profile, quality, skills, confidence, route, and the question it would ask). It touches neither the prompt box nor the conversation, and asks nothing: where a question would come up, it writes the assumptions instead.

The prompt box itself is the preview. The rewrite is placed there, where you can read and edit all of it, because the row above the prompt is only a few lines tall. **Restore** undoes it in one key.

## Modes

Press `m` to cycle. The mode is remembered across sessions. The default is set by the `mode` option.

| Mode | What it does | Model calls |
|---|---|---|
| **Quick** | Fixes spelling, typos and grammar, and clarifies wording. Keeps your structure, with no sections, skills or questions. | 1 |
| **Smart** (default) | Understands intent and constraints, picks the task type and its structure, names fitting skills, and asks at most one question when it matters. A simple ask stays short. | 1, plus 1 per answered question, plus at most 1 revision |
| **Deep** | Reads the context more closely, splits complex work into stages with checks, adds verification steps, may ask up to 2 questions, and names up to 5 skills. | the same, with longer output |

## What Smart and Deep do

1. **Understand.** One model call returns a structured reading of the draft. It keeps the corrected text, the primary and secondary intents, the task types (25 kinds), the desired outcome and target, and observed facts, kept apart from requirements. Explicit requirements are kept apart from inferred ones, with prohibited changes, assumptions, missing information, risks, a risk level, a confidence per dimension (intent, scope, target, behaviour), skill picks, questions, verification checks and the draft prompt. "Make everything work properly" is read as *improve reliability*, not *rewrite*. "Don't add anything new" stays a hard limit. "Fix X" stays a debugging task until the cause is found.
2. **Route.** Local rules use the lowest of the four confidences:
   - **High** (≥ 0.7): goes straight on.
   - **Medium** (0.55–0.7): goes on with its assumptions written into the prompt as one line ("Assumed: …. If one is wrong, stop and ask.").
   - **Low** (< 0.55): asks.
   - **High risk** (production data, deletion, deployment, payments, permissions, secrets, migrations): asks below 0.7 even when otherwise sure enough. Risk comes from the model and from a local word check, whichever is higher.

   A question is asked only if the model offered a specific one. The thresholds are options.
3. **Clarify.** See below.
4. **Build.** The prompt body is written for the target model's profile. The mod adds the skills line itself, after checking each name against the session's own skill listing, and the assumptions line.
5. **Check.** A local checker scores the prompt out of 100 on ten heuristics. A substantive problem triggers one revision, which is kept only if it scores higher. Substantive problems are: a changed file name or code token, a lost constraint, a path that appears nowhere in the draft or project, an action you did not ask for (deploy, delete, push…), an uninstalled skill, an impossible criterion such as "zero bugs", the wrong format for the model, or far too many words. Nothing in the score rewards length or extra requirements.
6. **Apply.** Secrets (API keys, tokens, private keys, `password=` values) are redacted, and the row says how many. If you edited the box meanwhile, your edit wins and the rewrite is dropped.

### Clarification

By default a question opens in Claude Code's own question dialog: 2 to 4 choices, the recommended one marked, and **Other** for your own answer. If the dialog is unavailable or you dismiss it, the same question shows in the row, with numbered buttons, an **Other** field, **Skip** and **Cancel**. Set `clarify` to `band` to always ask in the row.

- Each answer goes into the next request as your instruction, and is never asked again.
- **Skip** finishes without another model call and writes the assumptions into the prompt.
- At most `maxRounds` questions (default 3) are asked per enhancement.
- On the mobile app there is no text field, so the numbered choices and Skip remain.

## Target models

The `target` option chooses who reads the prompt.

| `target` | Prompt style | Skills |
|---|---|---|
| `auto` (default) | Detected from this session's model (`$.session.model()`): Claude names give **Claude**, `gpt` gives **GPT**, `o1`–`o9` or "reasoning"/"thinking" give **Reasoning**, `gemini` gives **Gemini**, anything else gives **Universal** | named, since the prompt runs here |
| `claude` | Direct instructions with reasons, XML sections only for 3+ parts, calm wording | none (for use elsewhere) |
| `gpt` | Objective first, then constraints and expected output, Markdown headings, no reasoning scaffolding | none |
| `reasoning` | Objective, evidence, constraints and success conditions; never "think step by step" | none |
| `gemini` | Clear instructions, explicit output format, one example only if it removes ambiguity | none |
| `universal` | Plain portable Markdown | none |

The mod calls no outside provider: every call goes through this session's own client. It forks the session's own conversation when there is one, and otherwise calls `sonnet` with no history.

## Options

Set them in `/config` (each is a row there) or in settings under `pluginConfigs.prompt-enhancer-plus.options`.

| Option | Default | Meaning |
|---|---|---|
| `mode` | `smart` | Starting mode, until you press `m` |
| `target` | `auto` | See [Target models](#target-models) |
| `clarify` | `dialog` | `dialog` or `band` |
| `askBelow` | `0.55` | Ask when the lowest confidence is below this |
| `assumeBelow` | `0.7` | Below this, list assumptions; risky work asks |
| `maxRounds` | `3` | Most questions per enhancement (0–5) |

## Context it reads

Only what the task needs, and never the whole disk:

- the conversation (through the fork),
- the project folder's path,
- the first 2,500 characters of the project's `CLAUDE.md` when there is no conversation yet (with secrets redacted),
- whether each path the draft names exists (at most 8 checks),
- the names of the installed skills, with one-line descriptions for the 40 that best match the draft.

All of this is passed to the model as data inside tags. Text in the draft or the context that addresses the model ("ignore your rules…") is carried over as content, not obeyed. Prompts are not logged.

## Reliability

- Each model call has a 90-second timer.
- A failed completion is retried once.
- An invalid reply gets one repair request, then fails with a message.
- A version counter means a cancelled or superseded run never writes its result.
- A press returns at once, because a rewrite can outlast the 10-second press budget. The phase blocks a second run while one is in progress.

## Architecture

| File | Holds |
|---|---|
| `hooks/core.ts` | No engine access. Builds the requests (analysis, quick, revision), the 25 task strategies, the 5 versioned model profiles, the JSON parser with safe defaults, routing, protected-token extraction, the local risk check, skill ranking and verification, secret redaction, assembly, and the quality checker. |
| `hooks/register.tsx` | Engine-facing code: context gathering, model calls with fallback, timeout and retry, clarification (dialog, then band), the enhancement pipeline, the band UI for every state, and the session start. |
| `types/index.d.ts` | State contract: `phase`, `step`, `note`, `question`, `preview`, `mode`, `version`, `focusKey`. |
| `tests/enhancer.test.ts` | 29 integration tests through the engine's test kit, with only the model and prompt box faked. |
| `tests/core.test.ts` | 13 unit tests, including deterministic checks over the 100-prompt golden set. |
| `tests/keybindings.test.ts`, `tests/prompt-enhancer-compose.test.tsx` | The v0.3.0 hint and band-composition tests, kept. |
| `tests/golden/` | The golden set: 100 rough prompts, 50 dev and 50 held-out, generated by `eval/make_golden.py`. |
| `eval/run.ts` | Live comparison with v0.3.0 on the golden set through the real model; results go in `eval/results/`. |

## Develop

```sh
claude plugin validate .
claude plugin test .
bun eval/run.ts heldout       # live comparison, about $0.10 per prompt (isolated claude -p, sonnet)
```

v0.3.0 is the first commit in this folder's git history (`git show c315da3`), so you can always go back to it.

## Measured results (2026-11-01, held-out half, 50 prompts)

Both versions ran through the same isolated `claude -p --model sonnet`, with the same 803 local skills. Full rows are in `eval/results/heldout-2026-11-01.json`.

| Measure | v0.3.0 | v0.4.0 |
|---|---|---|
| Typos fixed (where the golden set marks them) | 100% | 100% |
| Exact tokens kept / constraints kept | 100% / 100% | 100% / 100% |
| Unasked risky actions added | 0 | 1 |
| Prompts naming a skill (all verified installed) | 0 | 25 |
| Task family correct / primary type correct | n/a | 92% / 74% |
| Asked when it should (recall) | n/a (never asks) | 100% (7/7) |
| Asked when it need not | n/a | 30% |
| Median words | 205 | 182 |
| Median latency | 7.6 s | 19.2 s |
| Model cost for 50 prompts | $0.63 | $4.10 |
| Blind pairwise judge, skills line removed (v0.4 / v0.3 / tie) | | 23 / 24 / 3 |

In plain words: on prompt-body quality alone, a blind judge rates the two versions even. v0.4.0's gains are the ones v0.3.0 could not do at all: verified skills, task classification, questions for vague or risky requests, model profiles, and the checks. It costs about 2.5× the latency and 6.5× the tokens, and it asks too often (30% of clear prompts). That is the first thing to tune with `askBelow`. No agent task was executed end to end to compare outcomes.

## Focus chord

The chord that focuses the row is Claude Code's `abovePrompt:focus` action (`ctrl+x tab` by default). Bind your own in `~/.claude/keybindings.json` with a `Chat` block, for example `{ "context": "Chat", "bindings": { "cmd+e": "abovePrompt:focus" } }`. The row shows whichever chord applies, read when a session starts.

## Known limits

- **Confidence is the model's own estimate**, calibrated only roughly against the dev half of the golden set. It is not a statistical probability.
- **The quality score is a heuristic** for diagnostics. It does not measure whether the agent then succeeds.
- **The fork cannot be cancelled mid-flight.** Cancel makes its result stale so it is never written, and it still finishes in the background. A plain completion is cut at once.
- **The fork sees the conversation up to the last request** the running turn sent.
- **`$.ui.ask` may not be available everywhere.** Where it rejects, the question falls back to the row.
- **The transcript labels a sent prompt as from the plugin** (`asUser: true` keeps the model reading it as yours). Enter sends it as an ordinary prompt.
- **Long rewrites can push the row off a short terminal.** The keys still reach it.
