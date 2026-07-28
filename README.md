# beamup

**Move a Claude Code session between devices.** Same conversation, same
context, a different computer underneath.

You're debugging on your laptop and need the GPU box. You type `/beam`, pick
the device, and the screen redraws with *the conversation you were just having*
— except now every command runs over there, at native speed, with that
machine's own `CLAUDE.md`, hooks and MCP servers. `/beam home` brings you back,
along with whatever you changed.

A device is any machine you can ssh to. It is also, if you want one, a cloud
sandbox on your own E2B account — same list, same verb, nothing new to learn.

No account. No daemon. No server. It uses the SSH you already have.

## Install

```bash
npm i -g beamup
beamup install-shell   # optional: keep typing `claude`
```

`beamup` takes the same options as `claude` and hands the terminal straight to
the real Claude Code — it's a supervisor, not a replacement.

```bash
beamup                # like `claude`
beamup --model opus   # any claude flag works
```

With `install-shell`, one delimited block is added to your `.bashrc`, `.zshrc`
or `config.fish`:

```sh
claude() { command beamup "$@"; }
```

so the command you type stays `claude`. This is the same trick `nvm`, `pyenv`
and `direnv` use. `command claude` still runs Claude Code directly, and
`beamup uninstall-shell` restores the file exactly as it was (it's backed up
before the first edit either way).

## Use

Inside a session:

```
/beam                        pick a device, then a folder
/beam gpu-box                pick a folder on gpu-box
/beam gpu-box:~/trainer      go straight there
/beam cloud                  go to your cloud box
/beam home                   return to where this session started
```

`local` is a device like any other, so `/beam` also moves a conversation
between folders on the machine you're already on — something Claude Code can't
otherwise do mid-session.

Outside a session:

```bash
beamup devices               list devices and what they're doing
beamup doctor gpu-box        check a device is ready
beamup cloud                 set up the cloud box
beamup install-shell         make `claude` beam-capable
beamup uninstall-shell       undo that
```

## The picker

```
  beam to
  ⌂ local                you are here
  ● gpu-box              2h ago
  ○ mac-mini             yesterday
  ☁ cloud                paused
```

Devices come from your `~/.ssh/config` — there's no registry to maintain. If
you can `ssh` there, it's already a destination. `cloud` is always in the list,
set up or not.

Folders come from that device's own Claude Code history: every directory you've
actually worked in, newest first, with branch and dirty-file count so you can
see what you're walking into. The folder you used last is pre-selected, so
returning somewhere is `/beam` → ⏎ → ⏎.

## What travels

- **The conversation.** The session transcript is copied to the destination and
  resumed there. It is the same session id, so the context is genuinely intact
  rather than summarised.
- **Your uncommitted work**, if the folder is a git repo — modified files and
  untracked ones both. It comes back when you do.
- **Nothing else.** Settings, MCP servers, hooks and credentials all belong to
  the device you're on. That's the point: you get *that* machine's environment.

### How carrying work stays safe

Uncommitted changes are the easiest thing in the world to lose, so every
operation either verifies its assumption or refuses:

- The destination must be on the **same commit**. A patch applied to a different
  base is how work silently disappears.
- The destination must be **clean**, unless it's the tree you left.
- Coming home, the folder you left must be **unchanged**. If something edited it
  while you were away, beamup refuses and saves the incoming work to
  `~/.beamup/incoming-<timestamp>/` rather than overwriting anything.

## The cloud box

`/beam cloud` is a sandbox that behaves like any other device. The first time,
it asks for an E2B key and sets itself up; after that it's two lines on screen
and about a second.

```
/beam cloud

  · waking the cloud box
  · carried 3 changed file(s)
```

**It runs on your account.** beamup operates no infrastructure, holds no keys
and proxies nothing — your code goes from your machine to your sandbox on your
own [E2B](https://e2b.dev) account, with nothing in between. There is no hosted
beamup and there is not going to be one.

A few decisions worth knowing about:

- **It's one box, and it persists.** Pausing preserves the filesystem *and*
  memory, indefinitely, and resuming takes about a second. So the box stays
  signed in and keeps whatever you installed on it. It's a machine you happen to
  rent by the second, not a fresh container each time.
- **It pauses the moment you leave**, and says so. It also can't run away from
  you: every sandbox is created with a finite timeout and `autoPause`, so even
  if beamup is killed outright the box puts itself to sleep instead of billing
  you until you notice.
- **A fresh box is seeded from your laptop, not from GitHub.** beamup ships a
  `git bundle` of your history so the box lands on the exact commit your
  uncommitted work was written against. That means it works on repos you've
  never pushed and branches that only exist locally — and the box never needs a
  credential for your git host.
- **The E2B SDK is not a dependency.** It's fetched into `~/.beamup/deps` the
  first time you set the cloud box up. Installing beamup pulls nothing for a
  feature you haven't used.

`beamup cloud destroy` gets rid of it. `beamup cloud repair` builds a new one.

## Requirements

On a device you beam **to**: `ssh` access, Claude Code (signed in), `node` 18+,
and `git`. `beamup doctor <device>` tells you what's missing. The cloud box
installs its own.

Each device signs in to Claude Code itself, with `claude auth login`. This is
deliberate and will not change — see below.

## Non-goals

- **No credential forwarding, ever.** beamup will never proxy model calls
  through your laptop or ship your token to another device. Anthropic's terms
  prohibit using Claude subscription OAuth tokens in other products or services;
  each device authenticating itself is the only correct design, not a limitation
  to be engineered around. The cloud box is no exception: it signs itself in, in
  its own terminal, and that sign-in survives because a paused sandbox keeps its
  filesystem.
- **No hosted service, and no beamup-operated anything.** Not a relay, not a
  proxy, not a default API key, not even a sandbox image published under a
  maintainer's account. Nothing in the runtime path depends on infrastructure
  you don't control.
- **Not a sandbox** (the ssh kind). Claude Code runs on the far machine as you,
  with your access — the same as if you'd ssh'd in and started it yourself. The
  cloud box *is* isolated, which is a reason to use it, but that's a property of
  E2B rather than of beamup.
- **Not team access control.** It's your devices and your keys.

## How it works

1. `beamup` launches the real `claude` with a small bundled plugin and waits.
2. `/beam` calls a tool that writes a request file. A slash command can't take
   over the terminal, so it doesn't try.
3. The plugin's `Stop` hook ends the session at the turn boundary — after the
   transcript is completely written.
4. The supervisor, which has owned the terminal all along, ships the transcript
   and your changes to the destination and launches the real `claude` there,
   attached to your terminal.

There's no protocol to speak and no daemon on the far side; ssh connection
sharing keeps the repeated calls at ~10ms each.

### Why a supervisor, and not just a plugin

The plugin half needs no supervisor at all — `/beam` works perfectly well inside
a normally-installed plugin. What a plugin cannot do is perform the move.

Moving means ending the local `claude`, running Claude Code on the far device
**attached to your terminal**, and relaunching locally when it comes back. That
needs a process which outlives the local session and holds the terminal. Hooks
and MCP servers are children of `claude`: they die with it, and the shell takes
the terminal back the instant it exits. Anything left running in the background
that tried to read the terminal would be competing with your shell prompt for
keystrokes.

So the supervisor is not an implementation shortcut — it's the only place the
swap can happen. Shell integration exists so that being unavoidable doesn't also
mean being something you have to remember.

### Adding a device kind

Everything above `src/device/` is transport-free. A device implements nine
methods — `ensureUp`, `probe`, `isOnline`, `exec`, `attach`, `pushDir`,
`pullDir`, `release`, `dispose` — and gets the picker, the carry invariants and
the whole supervisor loop for free. `SshDevice` is fifty lines; `E2BDevice` is
the interesting one, because it has a lifecycle.

Fly Machines, Modal, Daytona, a Codespace, a plain VM with a start hook: all of
those are `SshDevice` plus `ensureUp`/`release`. That's the intended shape of a
contribution.

## Development

```bash
npm test          # unit tests — no network, no accounts
npm run test:e2e  # end-to-end, needs a reachable host in BEAMUP_HOST
```

The unit suite drives the real seeding and carrying logic through a fake device
that shells out locally, so bundle → clone → patch is exercised without any
host.

The e2e suite needs a machine you can ssh into that has Claude Code signed in.
To use your own box as that machine, add a key and an ssh alias:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/beamup_e2e -N ""
printf 'from="127.0.0.1,::1" %s\n' "$(cat ~/.ssh/beamup_e2e.pub)" >> ~/.ssh/authorized_keys
cat >> ~/.ssh/config <<'EOF'
Host beamup-localhost
  HostName 127.0.0.1
  IdentityFile ~/.ssh/beamup_e2e
EOF
```

Remove both when you're done.

## Licence

MIT.

---

Not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude
Code are trademarks of Anthropic, PBC. Claude Code has its own built-in
`/teleport`, which moves a session between your terminal and Claude Code on the
web — a different thing from this, which moves sessions between your own
devices. Not affiliated with the Apache Beam project or Gravitational's
Teleport.
