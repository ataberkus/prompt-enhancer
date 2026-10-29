# prompt-enhancer

Turns a short coding-agent prompt into a complete, repo-grounded spec before you send it. It's the ✨ Enhance from
[omp-companion](../omp-companion), packaged as an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension.

## Use

1. Type your prompt in omp's composer.
2. Press **Alt+E**. The status line shows `✨ Enhancing…` and which file it is reading.
3. The enhanced prompt replaces your draft. Edit it if you like, then press Enter to send.

- **Alt+E** again, before you edit the result: puts your original draft back.
- **Alt+E** while it runs: cancels.
- `/enhance <prompt>`: same thing for a prompt you type after the command.

If you change the composer while an enhance is running, you're asked before your text is replaced.

Works in omp's terminal UI and in omp inside [Tern](https://stencil.so/tern).

## How it works

Each enhance is one separate, locked-down `omp -p` run in the session's folder:

- it can only use `read`, `grep` and `glob`, inside the repository, at most 12 lookups and no `.env` files (`core/guard.mjs`);
- every discovery provider, MCP, memory and other tools are off (`core/overlay.yml`);
- it uses the system prompt in `core/system.md`, gets your draft and the last 6 turns of the conversation on stdin, and
  writes nothing.

It runs on an `enhance` model role if you configured one in omp (`modelRoles.enhance` in `config.yml`). Otherwise it uses
the session's model and thinking level.

`core/enhance.mjs` has no omp-specific code, so other agents can get a front end later.

## Install

Tested with omp 18.13.3.

```sh
# try it for one session
omp -e /path/to/prompt-enhancer

# install it for every session (a link, so edits here apply after restarting omp)
omp plugin link /path/to/prompt-enhancer
```

## Develop

```sh
npm test
```

`core/system.md`, `core/overlay.yml` and `core/guard.mjs` were copied from omp-companion's `companion/server.mjs`
(`ENHANCE_SYSTEM`, `ENHANCE_OVERLAY`, `ENHANCE_GUARD`) at commit `fba8f5a`. Change them in both places, or the two drift
apart.
