# ccteleport

**Move a Claude Code session between machines.** Same conversation, same
context, different computer underneath.

You're debugging on your laptop and need the GPU box. You type `/teleport`, pick
the machine, and the screen redraws with *the conversation you were just having*
— except now every command runs over there, at native speed, with that machine's
own `CLAUDE.md`, hooks and MCP servers. `/back` brings you home, along with
whatever you changed.

No account. No daemon. No server. It uses the SSH you already have.

## Install

```bash
npm i -g ccteleport
ccteleport install-shell   # optional: keep typing `claude`
```

`ccteleport` takes the same options as `claude` and hands the terminal straight
to the real Claude Code — it's a supervisor, not a replacement.

```bash
ccteleport                # like `claude`
ccteleport --model opus   # any claude flag works
```

With `install-shell`, one delimited block is added to your `.bashrc`, `.zshrc`
or `config.fish`:

```sh
claude() { command ccteleport "$@"; }
```

so the command you type stays `claude`. This is the same trick `nvm`, `pyenv`
and `direnv` use. `command claude` still runs Claude Code directly, and
`ccteleport uninstall-shell` restores the file exactly as it was (it's backed up
before the first edit either way).

## Use

Inside a session:

```
/teleport                    pick a machine, then a folder
/teleport gpu-box            pick a folder on gpu-box
/teleport gpu-box:~/trainer  go straight there
/back                        return to where this session started
```

`local` is always in the machine list, so `/teleport` also moves a conversation
between folders on the machine you're already on — something Claude Code can't
otherwise do mid-session.

Outside a session:

```bash
ccteleport machines          list known machines
ccteleport doctor gpu-box    check a machine is ready
ccteleport install-shell     make `claude` teleport-capable
ccteleport uninstall-shell   undo that
```

## The picker

Machines come from your `~/.ssh/config` — there's no registry to maintain. If
you can `ssh` there, it's already a destination.

Folders come from that machine's own Claude Code history: every directory you've
actually worked in, newest first, with branch and dirty-file count so you can see
what you're walking into. The folder you used last is pre-selected, so returning
somewhere is `/teleport` → ⏎ → ⏎.

## What travels

- **The conversation.** The session transcript is copied to the destination and
  resumed there. It is the same session id, so the context is genuinely intact
  rather than summarised.
- **Your uncommitted work**, if the folder is a git repo — modified files and
  untracked ones both. It comes back when you do.
- **Nothing else.** Settings, MCP servers, hooks and credentials all belong to
  the machine you're on. That's the point: you get *that* machine's environment.

### How carrying work stays safe

Uncommitted changes are the easiest thing in the world to lose, so every
operation either verifies its assumption or refuses:

- The destination must be on the **same commit**. A patch applied to a different
  base is how work silently disappears.
- The destination must be **clean**, unless it's the tree you left.
- Coming home, the folder you left must be **unchanged**. If something edited it
  while you were away, ccteleport refuses and saves the incoming work to
  `~/.ccteleport/incoming-<timestamp>/` rather than overwriting anything.

## Requirements

On the machine you teleport **to**: `ssh` access, Claude Code (signed in),
`node` 18+, and `git`. `ccteleport doctor <machine>` tells you what's missing.

Each machine signs in to Claude Code itself, with `claude auth login`. This is
deliberate and will not change — see below.

## Non-goals

- **No credential forwarding, ever.** ccteleport will never proxy model calls
  through your laptop or ship your token to another machine. Anthropic's terms
  prohibit using Claude subscription OAuth tokens in other products or services;
  each machine authenticating itself is the only correct design, not a
  limitation to be engineered around.
- **Not a sandbox.** Claude Code runs on the far machine as you, with your
  access — the same as if you'd ssh'd in and started it yourself.
- **Not team access control.** It's your machines and your SSH keys.
- **No hosted service.** There is nothing to sign up for and nothing in the
  middle. Your transcripts go from your machine to your machine.

## How it works

1. `ccteleport` launches the real `claude` with a small bundled plugin and waits.
2. `/teleport` calls a tool that writes a request file. A slash command can't
   take over the terminal, so it doesn't try.
3. The plugin's `Stop` hook ends the session at the turn boundary — after the
   transcript is completely written.
4. The supervisor, which has owned the terminal all along, ships the transcript
   and your changes over ssh and launches the real `claude` there with
   `--resume`, attached to your terminal via `ssh -t`.

There's no protocol to speak and no daemon on the far side; ssh connection
sharing keeps the repeated calls at ~10ms each.

### Why a supervisor, and not just a plugin

The plugin half needs no supervisor at all — `/teleport` works perfectly well
inside a normally-installed plugin. What a plugin cannot do is perform the move.

Moving means ending the local `claude`, running `ssh -t <machine> claude
--resume` **attached to your terminal**, and relaunching locally when it comes
back. That needs a process which outlives the local session and holds the
terminal. Hooks and MCP servers are children of `claude`: they die with it, and
the shell takes the terminal back the instant it exits. Anything left running in
the background that tried to read the terminal would be competing with your
shell prompt for keystrokes.

So the supervisor is not an implementation shortcut — it's the only place the
swap can happen. Shell integration exists so that being unavoidable doesn't also
mean being something you have to remember.

## Development

```bash
npm test        # unit tests
npm run test:e2e  # end-to-end, needs a reachable host in CCT_HOST
```

The e2e suite needs a machine you can ssh into that has Claude Code signed in.
To use your own box as that machine, add a key and an ssh alias:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/cct_e2e -N ""
printf 'from="127.0.0.1,::1" %s\n' "$(cat ~/.ssh/cct_e2e.pub)" >> ~/.ssh/authorized_keys
cat >> ~/.ssh/config <<'EOF'
Host cct-localhost
  HostName 127.0.0.1
  IdentityFile ~/.ssh/cct_e2e
EOF
```

Remove both when you're done.

## Licence

MIT.

---

Not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude
Code are trademarks of Anthropic, PBC. Not affiliated with Gravitational's
Teleport.
