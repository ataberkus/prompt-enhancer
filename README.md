# prompt-enhancer

Turns a short coding-agent prompt into a complete, repo-grounded spec before you send it. It's the ✨ Enhance from
[omp-companion](../omp-companion), packaged as an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension and a
[Claude Code](https://code.claude.com) plugin. Each host runs the enhancer with its own CLI: omp with `omp -p`, Claude Code
with `claude -p`. The Claude Code plugin does not need omp.

## Use

### omp

1. Type your prompt in omp's composer.
2. Press **Alt+E**. The status line shows `✨ Enhancing…` and which file it is reading.
3. The enhanced prompt replaces your draft. Edit it if you like, then press Enter to send.

- **Alt+E** again, before you edit the result: puts your original draft back.
- **Alt+E** while it runs: cancels.
- `/enhance <prompt>`: same thing for a prompt you type after the command.

If you change the composer while an enhance is running, you're asked before your text is replaced.

Images and videos attached in the composer stay attached: the enhancer sees each as `[Image #N]`, and the result keeps
its chip (one the enhancer left out is added at the end). The enhancer reads only the marker, not the image itself.

Works in omp's terminal UI and in omp inside [Tern](https://stencil.so/tern).

### Claude Code

1. Start your prompt with `::e`, e.g. `::e add rate limiting to the upload endpoint`, and press Enter.
2. Claude Code shows `✨ Enhancing prompt (::e)…`. Your draft is not sent to Claude.
3. The enhanced prompt appears as the hook's block message. Copy it, edit it if you like, and send it.

- If the enhance fails or is cancelled, the message says so (`Enhance failed: …` / `Enhance cancelled.`) and shows your
  draft. Nothing is sent to Claude.
- `::e` with nothing after it only shows a reminder.
- The enhancer gets the last 6 turns of the Claude Code conversation, read from the session transcript, and runs on the
  session's current model.
- Each enhance is a separate `claude -p` run, billed to your Claude account like any other request.
- To show the enhancer an image, write its file path in the draft: `::e match this layout shots/header.png`, `@shots/a.jpg`
  or `"C:\My shots\a.webp"` (quotes for a path with spaces), relative to the session's folder or absolute. PNG, JPEG, GIF
  and WebP files go to the enhancer with the draft; a path to no file stays plain text. The enhanced prompt keeps each path,
  so Claude reads the image when you send it. Images pasted with Alt+V (`[Image #1]`) can't be used: Claude Code doesn't
  pass them to plugins, so the enhance stops and asks for a path.

Settings, read from the environment Claude Code runs in:

| Variable | Default | Meaning |
| :- | :- | :- |
| `PROMPT_ENHANCER_CLAUDE` | `claude` on `PATH` | The claude executable. Set it on Windows if claude is only an npm `claude.cmd` shim, which can't be started without a shell. |
| `PROMPT_ENHANCER_MODEL` | the session's model | Passed as `--model`, e.g. `sonnet`, `haiku` or a full model name. |
| `PROMPT_ENHANCER_EFFORT` | Claude Code's default | Passed as `--effort`: `low`, `medium`, `high`, `xhigh` or `max`. |

## How it works

Each enhance is one separate, locked-down agent run in the session's folder. It uses the system prompt in
`core/system.md`, gets your draft and the last 6 turns of the conversation on stdin, and writes nothing.

- **omp** (`omp -p`): only `read`, `grep` and `glob`, inside the repository, at most 12 lookups and no `.env` files
  (`core/guard.mjs`); every discovery provider, MCP, memory and other tools are off (`core/overlay.yml`).
- **Claude Code** (`claude -p`): only `Read`, `Grep` and `Glob`, with the same rules enforced by a `PreToolUse` hook
  (`core/claude-guard.mjs`). No settings files are loaded (`--setting-sources ''`), so no user hooks, plugins or MCP
  servers; no session is saved; `--permission-mode dontAsk` denies anything not allowed.

In omp it runs on an `enhance` model role if you configured one (`modelRoles.enhance` in `config.yml`). Otherwise it uses
the session's model and thinking level. In Claude Code it uses `PROMPT_ENHANCER_MODEL`/`PROMPT_ENHANCER_EFFORT`, or the
session's model and Claude Code's default effort.

`core/enhance.mjs` has no host-specific code: `runEnhance({ engine: 'omp' | 'claude', … })`. `omp/index.mjs` (omp extension)
and `claude/index.mjs` (Claude Code `UserPromptSubmit` hook, wired up in `hooks/hooks.json`) are thin front ends over it.

## Install

### omp

Tested with omp 18.13.3.

```sh
# try it for one session
omp -e /path/to/prompt-enhancer

# install it for every session (a link, so edits here apply after restarting omp)
omp plugin link /path/to/prompt-enhancer
```

### Claude Code

Needs `node` (20 or later) and `claude` on `PATH` (or `PROMPT_ENHANCER_CLAUDE`). Built against Claude Code 2.1.314.

```sh
# try it for one session
claude --plugin-dir /path/to/prompt-enhancer

# install it for every session (this checkout is its own marketplace)
claude plugin marketplace add /path/to/prompt-enhancer
claude plugin install prompt-enhancer@prompt-enhancer
```

The hook runs on every prompt you submit but exits at once unless the prompt starts with `::e`. Its timeout is 300 s,
above the enhancer's own 270 s limit.

## Develop

```sh
npm test
```

`core/system.md`, `core/overlay.yml` and `core/guard.mjs` were copied from omp-companion's `companion/server.mjs`
(`ENHANCE_SYSTEM`, `ENHANCE_OVERLAY`, `ENHANCE_GUARD`) at commit `fba8f5a`. Change them in both places, or the two drift
apart. `core/claude-guard.mjs` applies `core/guard.mjs`'s rules to Claude Code's tools; keep the two in step.
