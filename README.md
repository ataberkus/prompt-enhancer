# prompt-enhancer

Turns a short coding-agent prompt into a complete, repo-grounded spec before you send it. It's the ✨ Enhance from
[omp-companion](../omp-companion), packaged as an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension, a
[Claude Code](https://code.claude.com) plugin, a [Google Antigravity](https://antigravity.google) IDE extension and an
Antigravity CLI (`agy`) plugin; omp and Claude Code also work inside [Tern](https://stencil.so/tern). Each host runs
the enhancer with its own CLI: omp with `omp -p`, Claude Code with `claude -p`, and Antigravity with `agy -p` (or
`claude` / `omp` via `PROMPT_ENHANCER_ENGINE`).

## Modes

| Mode | omp | Claude Code | Antigravity IDE | Antigravity CLI (`agy`) | The enhanced prompt | Lookups |
| :- | :- | :- | :- | :- | :- | :- |
| full | **Alt+E**, `/enhance` | `::e`, `/enhance` | **Alt+E**, `Prompt Enhancer: Enhance` | `::e`, `/enhance` | Complete spec: Inferred requirements (data shapes, integration, lifecycle, failure paths, sibling flows); Added features; its "Done when" asks for tests of the new behaviour | 12 |
| notest | **Alt+Shift+N**, `/enhance-notest` | `::en`, `/enhance-notest` | **Alt+Shift+N**, `Prompt Enhancer: Enhance (no tests)` | `::en`, `/enhance-notest` | The same complete spec, Inferred requirements and Added features, with light checks instead of new tests | 12 |
| fast | **Alt+Shift+E**, `/enhance-fast` | `::ef`, `/enhance-fast` | **Alt+Shift+E**, `Prompt Enhancer: Enhance (fast)` | `::ef`, `/enhance-fast` | Lean: the request, at most 5 notes the change cannot work without, assumptions, light checks | 6 |
| max | **Alt+Shift+M**, `/enhance-max` | `::em`, `/enhance-max` | **Alt+Shift+M**, `Prompt Enhancer: Enhance (max)` | `::em`, `/enhance-max` | Best-in-class: the draft read as a product brief and expanded into the feature set the best products of its kind have, including the ones you didn't name; "Done when" runs the repo's existing checks and leaves testing to the agent | 12 |

Light checks (`core/light-checks.md`, shared by notest and fast) tell the agent to

- check only with the repo's existing typecheck, lint, unit tests and production build (a clean build is enough);
- not write new tests, regression tests included, unless your draft asks for them; only fix existing ones the change breaks;
- not run smoke tests or anything heavy: no browser or Playwright runs, dev servers, emulators, desktop automation or
  watchers, overriding the agent's own default to smoke-test.

Added features (full and notest, section 3 of `core/system.md`): for a feature or something new, the spec also lists the
features the best products of its kind have that you didn't name, usually 3 to 8, each a checkable behaviour in one line,
built with the repository's stack. `::e make a music player` gets a seek bar, volume and mute, shuffle and repeat, a queue,
keyboard shortcuts and the like on top of play and pause. Your own choices win; what the repository already has, and what
needs an account, server, paid API or credentials it doesn't have, is left out. A bug fix or a question gets none. Max mode
goes further:

The max mode is for building something, not for a precise change: `::em make a music player` asks for a player with play and
pause, previous and next, a seek bar with elapsed and remaining time, volume and mute, shuffle and repeat, a queue, keyboard
shortcuts, remembered volume and position, and empty, loading and error states. Its prompt (`core/system-max.md`) has

- **Feature set**: every item a checkable behaviour, grouped as Core (what you asked for and what the product can't do
  without), Expected (what every leading product of the kind has), Standout (shortcuts, remembered state, smart defaults,
  undo…) and Quality (empty, loading, error and edge states, accessibility, responsive layout, performance, persistence).
  Features that need an account, server, licence, paid API or credentials the repository doesn't have go on one Later line
  instead of being stubbed;
- **Implementation**: where it goes and which of the repository's components, stores and helpers it reuses, from the code
  the enhancer read; a new dependency only where a feature needs one, listed in Assumptions;
- **Done when**: every feature works, and the repository's existing build, typecheck, lint or test commands pass. It lists
  no tests to write and asks for none, not even a regression test: whether a test is worth adding is the agent's call;
- your own choices (a library, a layout, an exclusion) win over the features it adds. A bug fix gets the hardening of the
  broken flow, not new features; a question stays a question.

Everything else (restore, cancel, images, clipboard, settings) works the same in every mode.

## Use

### omp

1. Type your prompt in omp's composer.
2. Press **Alt+E**. The status line shows `✨ Enhancing…` and which file it is reading.
3. The enhanced prompt replaces your draft. Edit it if you like, then press Enter to send.

- **Alt+E** again, before you edit the result: puts your original draft back.
- **Alt+E** while it runs: cancels.
- `/enhance <prompt>`: same thing for a prompt you type after the command.
- **Alt+Shift+N** / `/enhance-notest <prompt>`, **Alt+Shift+E** / `/enhance-fast <prompt>` and **Alt+Shift+M** /
  `/enhance-max <prompt>`: the [other modes](#modes);
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
- `::en <prompt>` / `/enhance-notest <prompt>`, `::ef <prompt>` / `/enhance-fast <prompt>` and `::em <prompt>` /
  `/enhance-max <prompt>` (`/prompt-enhancer:enhance-notest`, `/prompt-enhancer:enhance-fast`, `/prompt-enhancer:enhance-max`)
  run the [other modes](#modes).
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

### Antigravity IDE

Antigravity IDE (verified on 1.107.0, VS Code-based) loads the extension in `antigravity/`. Because Antigravity IDE
does not expose a public VS Code extension API to read or write the Agent sidebar's input box or read its active
conversation transcript, the extension works in two ways:

1. **Selected text in an editor**: select your draft and press **Alt+E** (**Alt+Shift+N** notest, **Alt+Shift+E** fast,
   **Alt+Shift+M** max) or run `Prompt Enhancer: Enhance` from the Command Palette. The status bar shows
   `✨ Enhancing…` and each lookup (`reading …`, `searching …`, `listing …`). When done, the selection is replaced in
   place and copied to the clipboard. If you edited the selection while the enhancer ran, you are asked before it is
   replaced.
2. **No selection (Agent sidebar workflow)**: press **Alt+E** (or run the command from the Command Palette) to open an
   input box for your draft. The enhanced prompt is copied to the clipboard (`Ctrl+V` into the Agent chat) and a
   notification offers **Open Result** (opens an untitled Markdown tab) and **Restore Draft**.

- **Same shortcut again**, before editing the result: restores your original draft (in the editor, or back to the
  clipboard for the input-box flow).
- **Same shortcut (or clicking the status bar)** while running: cancels (`Enhance cancelled.`).
- **Keybindings**: uses the same keys as omp (`Alt+E`, `Alt+Shift+N`, `Alt+Shift+E`, `Alt+Shift+M`). None conflict with
  default editor bindings; on Windows/Linux `Alt+E` overrides the Edit menu mnemonic while focused and can be rebound in
  Keyboard Shortcuts.
- **Conversation context**: Antigravity IDE does not expose the sidebar chat's active transcript to VS Code extensions,
  so IDE runs enhance without conversation history.
- **Images**: write image file paths in the draft (`shot.png`, `@shots/a.jpg`, `"C:\My shots\a.webp"`). Existing files
  are forwarded to the enhancer and kept in the result. Pasted sidebar image markers (`[Image #1]`) cannot be read by
  the extension and show a warning asking for a file path.
- **Settings**: configure `promptEnhancer.engine` (`antigravity`, `claude`, `omp`), `promptEnhancer.binary`,
  `promptEnhancer.model` and `promptEnhancer.effort` in IDE Settings, or override them with the environment variables
  below.

### Antigravity CLI (`agy`)

Verified against Antigravity CLI (`agy`) 1.5.8. The plugin ships `.antigravity-plugin/plugin.json`, root `hooks.json`
(`PreInvocation` + `PreToolUse`) and four skills (`skills/enhance*/SKILL.md`).

1. Start your prompt with `::e` (`::en`, `::ef`, `::em`) or `/enhance` (`/enhance-notest`, `/enhance-fast`,
   `/enhance-max`) followed by your draft, e.g. `::e add rate limiting to the upload endpoint`.
2. The `PreInvocation` hook intercepts the turn before the model runs. Your draft is never sent to the model.
3. The enhanced prompt is rendered inline (`metadata.user_markdown`, hidden from the model) and copied to the clipboard
   (`clip` on Windows, `pbcopy` on macOS, `wl-copy` or `xclip` on Linux). Paste it with Ctrl+V, edit if you like, and
   send.

- On failure or cancel, an error message (`Enhance failed: …` / `Enhance cancelled.`) is shown together with your
  original draft; nothing goes to the model.
- `::e` or `/enhance` with nothing after it only shows a reminder.
- **Conversation context & model**: reads the last 6 turns and the session's active model from `transcriptPath` (falling
  back to `modelName` when not `auto`).
- **Images**: write existing image paths in the draft (`shot.png`, `@shots/a.jpg`, `"C:\My shots\a.webp"`). `agy`
  1.5.8's `stream-json` input accepts text blocks only, so image paths are listed in `<images>` for `view_file` and
  preserved in the enhanced prompt. Pasted markers (`[Image #1]`) stop and ask for a file path.
- **Binary discovery**: checks `PROMPT_ENHANCER_ANTIGRAVITY`, then `process.execPath` when running under `agy`, then
  `~/.gemini/bin/agy.exe` (Windows) / `~/.gemini/bin/agy` (Unix), and finally `agy` on `PATH`.

Settings, read from the environment `agy` or Antigravity IDE runs in:

| Variable | Default | Meaning |
| :- | :- | :- |
| `PROMPT_ENHANCER_ANTIGRAVITY` | `~/.gemini/bin/agy(.exe)` or `agy` on `PATH` | The `agy` executable path. |
| `PROMPT_ENHANCER_ENGINE` | `antigravity` | Engine to run: `antigravity` (`agy -p`), `claude` (`claude -p`) or `omp` (`omp -p`). |
| `PROMPT_ENHANCER_MODEL` | session model (CLI) / engine default (IDE) | Passed as `--model`. |
| `PROMPT_ENHANCER_EFFORT` | engine default | Passed as `--effort` (`low`, `medium`, `high`, `xhigh`, `max`). |

### Tern

[Tern](https://stencil.so/tern) runs omp and Claude Code in its panes, and each loads this package itself, so both work
there as described above. No Tern plugin is involved: Tern's Luau plugins can type into a pane but can't read or replace
omp's composer.

- **omp**: open an agent block (**New agent block**, ⇧⌘A / Ctrl+Shift+A; its command is `omp` unless you changed it) or run
  `omp` in a shell pane. Tern draws omp's composer natively; the keys, slash commands, restore, cancel and attachment chips
  work as in a terminal. Tern's default keymap binds none of Alt+E, Alt+Shift+N, Alt+Shift+E and Alt+Shift+M, so they reach omp. A key
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
its `{{light-checks}}` slot; for max `core/system-max.md`. It gets your draft and the last 6 turns of the conversation on stdin, and writes nothing.

- **omp** (`omp -p`): only `read`, `grep` and `glob`, inside the repository, at most 12 lookups (6 in fast mode) and no `.env` files
  (`core/guard.mjs`); every discovery provider, MCP, memory and other tools are off (`core/overlay.yml`).
- **Claude Code** (`claude -p`): only `Read`, `Grep` and `Glob`, with the same rules enforced by a `PreToolUse` hook
  (`core/claude-guard.mjs`). No settings files are loaded (`--setting-sources ''`), so no user hooks, plugins or MCP
  servers; no session is saved; `--permission-mode dontAsk` denies anything not allowed. It inherits the hook's environment
  plus `CLAUDE_CODE_OAUTH_TOKEN` from `PROMPT_ENHANCER_OAUTH_TOKEN` when set; no settings file is needed to sign in.

- **Antigravity** (`agy -p`): runs `agy --input-format stream-json --output-format stream-json --disable-slash-commands --print-timeout 240s -p ""`
  with the draft and conversation on stdin (never in argv). Because `agy` 1.5.8 does not expose `--system-prompt`,
  `--tools`, `--setting-sources`, `--strict-mcp-config` or `--no-session-persistence` flags, the mode's system prompt
  rides in `<instructions>` on stdin, `--dangerously-skip-permissions` is omitted, and the plugin's `PreToolUse` hook
  (`core/antigravity-guard.mjs`, active only when `PROMPT_ENHANCER_GUARD_COUNTER` is set by `runEnhance`) enforces
  `view_file`/`grep_search`/`find_by_name`-only lookups inside the repo, no `.env` files, and the 12/6 lookup limit.
  Set `PROMPT_ENHANCER_ENGINE=claude` or `omp` if you want strict flag-level isolation of user settings/MCP/sessions.

In omp it runs on an `enhance` model role if you configured one (`modelRoles.enhance` in `config.yml`). Otherwise it uses
the session's model and thinking level. In Claude Code it uses `PROMPT_ENHANCER_MODEL`/`PROMPT_ENHANCER_EFFORT`, or the
session's model and Claude Code's default effort. In Antigravity CLI it uses `PROMPT_ENHANCER_MODEL`/
`PROMPT_ENHANCER_EFFORT`, or the session's model from `transcriptPath`; in Antigravity IDE it uses IDE settings or those
environment variables.

`core/enhance.mjs` has no host-specific code: `runEnhance({ engine: 'omp' | 'claude' | 'antigravity', mode: 'full' | 'notest' | 'fast' | 'max', … })`.
`omp/index.mjs` (omp extension), `claude/index.mjs` (Claude Code `UserPromptSubmit` and `UserPromptExpansion` hook, wired
up in `hooks/hooks.json`; `commands/enhance*.md` define the slash commands), `antigravity-cli/index.mjs` (Antigravity
`PreInvocation` hook, wired up in root `hooks.json` with `.antigravity-plugin/plugin.json` and `skills/enhance*/SKILL.md`)
and `antigravity/index.mjs` (`antigravity/extension.cjs`, VS Code-compatible Antigravity IDE extension) are thin front
ends over it. They are Tern's front ends too, since Tern runs omp and Claude Code as they are. The omp front end passes
`runEnhance` the binary running the session (`process.execPath`, whatever Tern names its managed omp), and `omp` on
`PATH` only when omp runs from source under bun or node.

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

The `::e` hook runs on every prompt you submit but exits at once unless the prompt starts with `::e`, `::en`, `::ef` or `::em`;
the `/enhance` hook runs only for `/enhance`, `/enhance-notest`, `/enhance-fast` and `/enhance-max`. Their timeout is 300 s, above the
enhancer's own 270 s limit.

### Antigravity CLI (`agy`)

Needs `node` (20 or later) and `agy` (`~/.gemini/bin/agy` or on `PATH`, or `PROMPT_ENHANCER_ANTIGRAVITY`). Verified
against `agy` 1.5.8.

```sh
# install globally by linking this checkout into Antigravity's global plugins folder
# macOS / Linux:
ln -s /path/to/prompt-enhancer ~/.gemini/config/plugins/prompt-enhancer
# Windows (PowerShell):
New-Item -ItemType Junction -Path "$env:USERPROFILE\.gemini\config\plugins\prompt-enhancer" -Target "C:\path\to\prompt-enhancer"

# or validate the plugin manifest and hooks with agy
agy plugin validate /path/to/prompt-enhancer
```

You can also enable it per workspace by adding an entry in `.agents/plugins.json` pointing to this checkout. The
`PreInvocation` hook timeout is 300 s (above the enhancer's 270 s limit), and `PreToolUse` (`core/antigravity-guard.mjs`)
is a no-op outside enhancer runs.

### Antigravity IDE

Needs `node` (20 or later) and `agy` (or `claude` / `omp` via `promptEnhancer.engine`). Verified against Antigravity IDE
1.107.0 (VS Code-based). Marketplace (Open VSX) publishing is not included; build the local `.vsix` package and install
it with `antigravity-ide`:

```sh
npm run vsix
antigravity-ide --install-extension prompt-enhancer-antigravity.vsix --force
```

Rebuild and reinstall the `.vsix` after making local edits. Reload the Antigravity IDE window, then press **Alt+E** or
open the Command Palette and run `Prompt Enhancer: Enhance`.

### Tern

Nothing to install for Tern itself: install the omp extension or the Claude Code plugin as above. Tern's managed omp uses
the same `~/.omp` as any other omp, so `omp plugin link` run in any terminal installs the extension for it too. Agent
blocks that are already open load it once restarted. For panes on a remote host, install it on that host, where their omp
or `claude` runs.

## Develop

```sh
npm test
```

The prompts live in omp-companion too, in `companion/enhance-prompts.mjs`: `core/system.md` is its `ENHANCE_SYSTEM`,
`core/system-fast.md` with `core/light-checks.md` its `ENHANCE_SYSTEM_FAST` and `ENHANCE_LIGHT_CHECKS`, `core/system-max.md`
its `ENHANCE_SYSTEM_MAX`; `core/overlay.yml` and `core/guard.mjs` are its `ENHANCE_OVERLAY` and `ENHANCE_GUARD`. Change them
in both places, or the two drift apart. The local differences: omp-companion's prompts add a sentence for a draft that is
only images, and `guard.mjs` reads its lookup limit from `PROMPT_ENHANCER_LOOKUP_LIMIT` (set per mode by `runEnhance`). The
notest mode swaps two passages of `core/system.md` (`FULL_CHECKS`, `FULL_REGRESSION` in `core/enhance.mjs`); if a re-sync
changes them, the notest enhance fails with `Prompt passage not found` and `npm test` fails, so update the passages there.
`core/claude-guard.mjs` and `core/antigravity-guard.mjs` apply `core/guard.mjs`'s rules to Claude Code's and
Antigravity's tools (their limit is the hook command's third argument, or `PROMPT_ENHANCER_LOOKUP_LIMIT` for
Antigravity); keep them in step.
