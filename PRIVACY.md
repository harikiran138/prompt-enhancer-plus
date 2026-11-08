# Privacy policy: Prompt Enhancer++

Last updated: 2026-11-08

Prompt Enhancer++ is a Claude Code mod that runs on your own computer, inside Claude Code. It has no server of its own and no account.

## What it reads

When you press Enhance or run `/enhance`, it reads:

- the draft in your prompt box,
- the conversation so far (through a forked model call),
- the project folder's path, and the first 2,500 characters of its `CLAUDE.md` when there is no conversation yet, with secrets redacted,
- whether up to 8 file paths named in your draft exist,
- the names and one-line descriptions of your installed skills,
- your `keybindings.json`, only to show the chord that focuses its row.

It reads nothing until you ask it to, never reads the whole disk, and never reads Claude's memory files.

## Where data goes

Everything above goes only to the model Claude Code is already using, on your own plan or API account, through Claude Code. The mod makes no other network requests. Anthropic's handling of that request is covered by your agreement with Anthropic.

## What it keeps

Only your chosen mode (Quick, Smart or Deep), in Claude Code's plugin storage on your computer. It keeps no logs of your prompts, drafts or answers, and the author receives nothing.

## Contact

Questions or concerns: open an issue at https://github.com/harikiran138/prompt-enhancer-plus/issues
