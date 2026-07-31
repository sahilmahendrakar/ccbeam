# Design notes

Background for anyone reading or extending the code. The [README](../README.md)
covers what ccbeam does; this covers why it's shaped the way it is.

## Why a supervisor, and not just a plugin

The plugin half needs no supervisor at all — `/ccbeam:up` works perfectly well
inside a normally-installed plugin. What a plugin cannot do is perform the move.

Moving means ending the local `claude`, running Claude Code on the far device
**attached to your terminal**, and relaunching locally when it comes back. That
needs a process which outlives the local session and holds the terminal. Hooks
and MCP servers are children of `claude`: they die with it, and the shell takes
the terminal back the instant it exits. Anything left running in the background
that tried to read the terminal would be competing with your shell prompt for
keystrokes.

So the supervisor isn't an implementation shortcut — it's the only place the
swap can happen. Shell integration exists so that being unavoidable doesn't also
mean being something you have to remember.

## The move, in order

1. `ccbeam` launches the real `claude` with the bundled plugin and waits.
2. `/ccbeam:up` calls the plugin's MCP tool, which writes a request file.
3. The plugin's `Stop` hook ends the session at the turn boundary, after the
   transcript is fully written.
4. The supervisor reads the request, resolves a device and folder (asking with
   the picker if needed), ships the runtime, transcript and any uncommitted work
   over, then launches the real `claude --resume <same session id>` there,
   attached to your terminal.
5. When that exits — because you beamed again, went home, or quit — the
   supervisor pulls the transcript and the work back and repeats.

Two checks happen before the terminal is handed over, both because the failure
they prevent is discovered too late to fix from the other side:

- **Can the destination load the plugin?** (`claude plugin details ccbeam`) If
  not, there'd be no `/ccbeam:up` over there, and no way back except quitting
  and abandoning the work.
- **Is the destination on the same commit, and clean?** A patch applied to a
  different base is how uncommitted work silently disappears.

The runtime is *replaced* on every beam rather than merged, so the two devices
can't drift to incompatible versions and a stale command can't linger next to a
renamed one.

## The device seam

Everything above `src/device/` is transport-free. A device implements nine
methods and gets the picker, the carry invariants and the whole supervisor loop
for free:

| | |
|---|---|
| `ensureUp` | make it reachable (a no-op for ssh; wake/create for cloud) |
| `probe` | claude / node / git / home / config dir |
| `isOnline` | cheap reachability check for listings |
| `exec` | run a command, get stdout/stderr/code |
| `attach` | run a command **on your terminal** |
| `pushDir` / `pullDir` | move a directory each way |
| `release` | done for now (pause a billing box) |
| `dispose` | drop the connection |

`SshDevice` is about fifty lines. `E2BDevice` is the interesting one, because it
has a lifecycle: create, resume, pause, destroy.

### Adding a device kind

Fly Machines, Modal, Daytona, a Codespace, a plain VM with a start hook: all of
those are `SshDevice` plus `ensureUp`/`release`. That's the intended shape of a
contribution.

The rules that matter for a new kind:

- **Never leave something billing.** `release()` is called on every exit path,
  including signals — but don't rely on it. Create resources with their own
  server-side idle timeout so a killed supervisor can't cost anyone money.
- **Seed from the local machine**, never from a git host. It keeps the
  same-commit invariant, works on unpushed repos, and means the far side never
  needs a credential for your git host.
- **Never carry credentials.** The device signs itself in to Claude Code.

## Cloud box specifics

- One box, named `cloud`, persistent. E2B's pause preserves filesystem and
  memory indefinitely; resume is ~1s. That's what lets it stay signed in.
- Created with `autoPause` and a finite timeout as the backstop.
- The E2B SDK is fetched to `~/.ccbeam/deps` at a pinned version on first cloud
  use, so installing ccbeam pulls nothing for an unused feature.
- Everything ccbeam writes inside the box lives under `~/.ccbeam/`. Not `/tmp`:
  the sticky bit there means a file written by one process can't be overwritten
  by the next, which turns into an `EACCES` on the *second* beam only.
- `Sandbox.betaPause(id, {apiKey})` (static) rather than the instance method,
  and the state is read back to confirm — the instance form has sent no auth
  header in the versions tested, which would silently leave boxes running.
- `pty.create` takes no command: write a script and `exec bash <file>`.

## Development

```bash
npm test          # unit — no network, no accounts
npm run test:e2e  # end-to-end, needs CCBEAM_HOST
```

The unit suite drives the real seeding and carrying logic through a fake device
that shells out locally, so bundle → clone → patch is exercised without a host.
Interactive prompts are covered by a fake-tty harness — a `PassThrough` with
`isTTY = true` — because with stdin closed every prompt returns its default
without touching readline, which once left the entire interactive path
uncovered.

The e2e suite needs a machine you can ssh into that has Claude Code signed in.
To use your own box as that machine, add a key and an ssh alias:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/ccbeam_e2e -N ""
printf 'from="127.0.0.1,::1" %s\n' "$(cat ~/.ssh/ccbeam_e2e.pub)" >> ~/.ssh/authorized_keys
cat >> ~/.ssh/config <<'EOF'
Host ccbeam-localhost
  HostName 127.0.0.1
  IdentityFile ~/.ssh/ccbeam_e2e
EOF
```

Remove both when you're done.

[TESTING.md](../TESTING.md) is the manual brief for the paths a machine can't
check by itself — chiefly a real interactive session inside the cloud box.

## The README demo

`docs/demo/ccbeam.gif` is recorded with [vhs](https://github.com/charmbracelet/vhs):

```bash
vhs docs/demo/demo.tape     # from the repo root
```

What plays is `docs/demo/demo.sh`, a **re-enactment** — it prints ccbeam's real
output with realistic pauses, rather than driving a live beam, so the GIF can be
re-recorded deterministically without two signed-in machines and a model turn.
Every string, colour and glyph in it is copied from `src/picker.mjs`,
`src/ui.mjs` and `bin/ccbeam.mjs`; if you change those, change the demo and
re-record.

The Claude Code welcome box in the GIF is **not** re-enacted — `docs/demo/header.ans`
is a recording of the real one, replayed by `cat`. Hand-drawing it never quite
matched; recording it cannot fail to. Refresh it with:

```bash
bash docs/demo/capture-header.sh
```

That runs `claude` under a PTY at the tape's exact width, strips the sequences
that only make sense live (alternate screen, mouse modes, capability queries)
and keeps the colour and cursor positioning that draw the box. Two things have
to hold or the box wraps: the capture width must match the tape's terminal
(93 columns at the current size — check with `stty size` inside a throwaway
tape), and `TERM`/`COLORTERM` must advertise truecolour, or Claude Code falls
back to a pale 16-colour theme.

Keep the whole demo under ~20 seconds. The payoff is the last beat — coming home
with the work — and a README GIF that takes forty seconds to get there is one
nobody sees the end of.
