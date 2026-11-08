# prompt-enhancer

Turns a short coding-agent prompt into a complete, repo-grounded spec before you send it. It's the ✨ Enhance from
[omp-companion](../omp-companion), packaged as an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension and a
[Claude Code](https://code.claude.com) plugin; both also work inside [Tern](https://stencil.so/tern). Each host runs the
enhancer with its own CLI: omp with `omp -p`, Claude Code with `claude -p`. The Claude Code plugin does not need omp.

## Modes

| Mode | omp | Claude Code | The enhanced prompt | Lookups |
| :- | :- | :- | :- | :- |
| full | **Alt+E**, `/enhance` | `::e`, `/enhance` | Complete spec: Inferred requirements (data shapes, integration, lifecycle, failure paths, sibling flows); its "Done when" asks for tests of the new behaviour | 12 |
| notest | **Alt+Shift+N**, `/enhance-notest` | `::en`, `/enhance-notest` | The same complete spec and Inferred requirements, with light checks instead of new tests | 12 |
| fast | **Alt+Shift+E**, `/enhance-fast` | `::ef`, `/enhance-fast` | Lean: the request, at most 5 notes the change cannot work without, assumptions, light checks | 6 |

Light checks (`core/light-checks.md`, shared by notest and fast) tell the agent to

- check only with the repo's existing typecheck, lint, unit tests and production build (a clean build is enough);
- not write new tests, regression tests included, unless your draft asks for them; only fix existing ones the change breaks;
- not run smoke tests or anything heavy: no browser or Playwright runs, dev servers, emulators, desktop automation or
  watchers, overriding the agent's own default to smoke-test.

Everything else (restore, cancel, images, clipboard, settings) works the same in every mode.

## Use

### omp

1. Type your prompt in omp's composer.
2. Press **Alt+E**. The status line shows `✨ Enhancing…` and which file it is reading.
3. The enhanced prompt replaces your draft. Edit it if you like, then press Enter to send.

- **Alt+E** again, before you edit the result: puts your original draft back.
- **Alt+E** while it runs: cancels.
- `/enhance <prompt>`: same thing for a prompt you type after the command.
- **Alt+Shift+N** / `/enhance-notest <prompt>` and **Alt+Shift+E** / `/enhance-fast <prompt>`: the [other modes](#modes);
  the same key again restores or cancels the same way.

If you change the composer while an enhance is running, you're asked before your text is replaced.

Images and videos attached in the composer stay attached: the enhancer sees each as `[Image #N]`, and the result keeps
its chip (one the enhancer left out is added at the end), so omp sends the original images with the enhanced prompt.

- `/enhance <prompt>` sent with images attached: the enhancer also sees each image, as an image after the prompt, listed by
  its `[Image #N]`. The send takes the images out of the composer, so the enhanced prompt shows them as `[Image #N, WxH]`
  markers and they are attached again when you send it. Videos reach the enhancer only as markers.
- **Alt+E**: omp doesn't give extensions the composer's images, so the enhancer reads only the markers; a warning says so.
  The images stay in the composer.
- An image the enhancer can't see (a model without image input, or not png, jpg, gif or webp) gets a warning and still
  goes with the prompt you send.

Works in omp's terminal UI and in omp inside [Tern](#tern).

### Claude Code

1. Start your prompt with `::e`, e.g. `::e add rate limiting to the upload endpoint`, or type `/enhance` and pick
   `/prompt-enhancer:enhance`, then write the prompt after it. Press Enter.
2. Claude Code shows `✨ Enhancing prompt…`. Your draft is not sent to Claude.
3. The enhanced prompt appears as the hook's block message and is copied to the clipboard (`clip` on Windows, `pbcopy`
   on macOS, `wl-copy` or `xclip` on Linux). Paste it into the prompt box with Ctrl+V, edit it if you like, and send it.
   Claude Code doesn't let a hook put text back in the prompt box itself.

- If the enhance fails or is cancelled, the message says so (`Enhance failed: …` / `Enhance cancelled.`) and shows your
  draft. Nothing is sent to Claude.
- `::e` or `/enhance` with nothing after it only shows a reminder.
- `::en <prompt>` / `/enhance-notest <prompt>` and `::ef <prompt>` / `/enhance-fast <prompt>` (`/prompt-enhancer:enhance-notest`,
  `/prompt-enhancer:enhance-fast`) run the [other modes](#modes).
- Cloud sessions (an environment other than this computer) don't load locally installed plugins, so neither works there:
  `::e` goes to Claude as written and `/enhance` only says the hook didn't run.
- The enhancer gets the last 6 turns of the Claude Code conversation, read from the session transcript, and runs on the
  session's current model.
- Each enhance is a separate `claude -p` run, billed to your Claude account like any other request. Claude Code doesn't
  give hooks the session's sign-in, so that run signs in as the `claude` on `PATH` is logged in (`claude auth status`), or
  with `PROMPT_ENHANCER_OAUTH_TOKEN`. If that is another account or organization than the session's (common with the
  Claude desktop app, whose sessions use the app's own sign-in), the API refuses it and Claude Code reports it as a billing
  problem ("can't use your Claude subscription… payment is past due"); the `Enhance failed:` message then names the HTTP
  error and this fix. Run `claude setup-token`, sign in to the account and organization the session uses, and put the token
  in `PROMPT_ENHANCER_OAUTH_TOKEN`, e.g. `"env": { "PROMPT_ENHANCER_OAUTH_TOKEN": "sk-ant-oat01-…" }` in
  `~/.claude/settings.json`; or run `claude auth login` and pick that organization.
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
| `PROMPT_ENHANCER_OAUTH_TOKEN` | the `claude` CLI's own login | A Claude subscription token from `claude setup-token`, passed to `claude -p` as `CLAUDE_CODE_OAUTH_TOKEN`. Set it when that login isn't the session's account or organization. |

### Tern

[Tern](https://stencil.so/tern) runs omp and Claude Code in its panes, and each loads this package itself, so both work
there as described above. No Tern plugin is involved: Tern's Luau plugins can type into a pane but can't read or replace
omp's composer.

- **omp**: open an agent block (**New agent block**, ⇧⌘A / Ctrl+Shift+A; its command is `omp` unless you changed it) or run
  `omp` in a shell pane. Tern draws omp's composer natively; the keys, slash commands, restore, cancel and attachment chips
  work as in a terminal. Tern's default keymap binds none of Alt+E, Alt+Shift+N and Alt+Shift+E, so they reach omp. A key
  you bind in Tern's `keybinds`, or one another Tern plugin binds, goes to Tern instead; use the slash command then.
- The enhancer runs with the omp binary of the session it was started from, Tern's managed omp (**Install omp** in the
  palette) included, so it never depends on which `omp` is on `PATH`.
- Closing an agent block (or Tern stopping it) while an enhance runs cancels the enhance.
- **Claude Code**: run `claude` in a pane, or set it as the agent command. `::e` and `/enhance` work as in any terminal,
  and the enhanced prompt is copied to the clipboard of the machine `claude` runs on. In a pane on a remote host
  (`tern remote`) that is the remote host's clipboard, so copy the prompt from the hook's message instead.

## How it works

Each enhance is one separate, locked-down agent run in the session's folder. It gets the mode's system prompt as text
(`modes` in `core/enhance.mjs`): `core/system.md` for full; for notest the same file with its "Done when" checks and
bug-fix regression check swapped for `core/light-checks.md`; for fast `core/system-fast.md` with `core/light-checks.md` in
its `{{light-checks}}` slot. It gets your draft and the last 6 turns of the conversation on stdin, and writes nothing.

- **omp** (`omp -p`): only `read`, `grep` and `glob`, inside the repository, at most 12 lookups (6 in fast mode) and no `.env` files
  (`core/guard.mjs`); every discovery provider, MCP, memory and other tools are off (`core/overlay.yml`).
- **Claude Code** (`claude -p`): only `Read`, `Grep` and `Glob`, with the same rules enforced by a `PreToolUse` hook
  (`core/claude-guard.mjs`). No settings files are loaded (`--setting-sources ''`), so no user hooks, plugins or MCP
  servers; no session is saved; `--permission-mode dontAsk` denies anything not allowed. It inherits the hook's environment
  plus `CLAUDE_CODE_OAUTH_TOKEN` from `PROMPT_ENHANCER_OAUTH_TOKEN` when set; no settings file is needed to sign in.

In omp it runs on an `enhance` model role if you configured one (`modelRoles.enhance` in `config.yml`). Otherwise it uses
the session's model and thinking level. In Claude Code it uses `PROMPT_ENHANCER_MODEL`/`PROMPT_ENHANCER_EFFORT`, or the
session's model and Claude Code's default effort.

`core/enhance.mjs` has no host-specific code: `runEnhance({ engine: 'omp' | 'claude', mode: 'full' | 'notest' | 'fast', … })`.
`omp/index.mjs` (omp extension) and `claude/index.mjs` (Claude Code `UserPromptSubmit` and `UserPromptExpansion` hook, wired
up in `hooks/hooks.json`; `commands/enhance.md`, `commands/enhance-notest.md` and `commands/enhance-fast.md` define the slash
commands) are thin front ends over it. They are Tern's front ends too, since Tern runs omp and Claude Code as they are. The
omp front end passes `runEnhance` the binary running the session (`process.execPath`, whatever Tern names its managed
omp), and `omp` on `PATH` only when omp runs from source under bun or node.

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

The `::e` hook runs on every prompt you submit but exits at once unless the prompt starts with `::e`, `::en` or `::ef`; the
`/enhance` hook runs only for `/enhance`, `/enhance-notest` and `/enhance-fast`. Their timeout is 300 s, above the
enhancer's own 270 s limit.

### Tern

Nothing to install for Tern itself: install the omp extension or the Claude Code plugin as above. Tern's managed omp uses
the same `~/.omp` as any other omp, so `omp plugin link` run in any terminal installs the extension for it too. Agent
blocks that are already open load it once restarted. For panes on a remote host, install it on that host, where their omp
or `claude` runs.

## Develop

```sh
npm test
```

`core/system.md`, `core/overlay.yml` and `core/guard.mjs` were copied from omp-companion's `companion/server.mjs`
(`ENHANCE_SYSTEM`, `ENHANCE_OVERLAY`, `ENHANCE_GUARD`) at commit `fba8f5a`. Change them in both places, or the two drift
apart; the one local change is `guard.mjs` reading its lookup limit from `PROMPT_ENHANCER_LOOKUP_LIMIT` (set per mode by
`runEnhance`). The notest mode swaps two passages of `core/system.md` (`FULL_CHECKS`, `FULL_REGRESSION` in
`core/enhance.mjs`); if a re-sync changes them, the notest enhance fails with `Prompt passage not found` and `npm test`
fails, so update the passages there. `core/system-fast.md` and `core/light-checks.md` exist only here.
`core/claude-guard.mjs` applies `core/guard.mjs`'s rules to Claude Code's tools (its limit is the hook command's third
argument); keep the two in step.
