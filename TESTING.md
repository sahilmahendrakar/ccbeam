# beamup — test brief

You are testing `beamup`, a tool that moves a Claude Code session between
machines. It launches the real `claude`, and on `/beam` ships the session
transcript and uncommitted git work over SSH and resumes the **same session** on
another machine attached to the same terminal.

Everything in this brief has been verified on a Linux box already, **except the
two things in Phase 4 and Phase 5** — those are the point of this exercise.
Report what actually happened, including anything that looked wrong but passed.

## Before you start — read this

- **Never run the carry tests in a repository whose uncommitted work matters.**
  `/beam` moves your dirty diff to another machine and `/beam home` moves it home,
  replacing the working tree in the process. Use throwaway repos created by the
  steps below.
- `install-shell` edits `~/.bashrc` / `~/.zshrc` / `config.fish`. It backs the
  file up first and `uninstall-shell` restores it byte-for-byte, but prefer
  `--rc /tmp/somefile` when you only want to check behaviour.
- Don't commit anything to the repo or push. Report findings only.

## Setup

```bash
git clone https://github.com/sahilmahendrakar/beamup   # private repo
cd beamup
node --version        # must be >= 18
```

It is not on npm. Either run it directly as `node /path/to/beamup/bin/beamup.mjs`
or `npm link` to get a real `beamup` on PATH. Use one form consistently and
say which you used.

## What you need

- **Machine A** — where you are. Claude Code installed and signed in.
- **Machine B** — any machine you can `ssh` into, with Claude Code **signed in
  there**, plus `node` 18+ and `git`.

To check B: `beamup doctor <host>` should end in `ready`.

**If B is a server you ssh into:** Claude Code's config location comes from
`CLAUDE_CONFIG_DIR`, which is usually **not set for non-interactive ssh
sessions** even if your shell profile sets it. So B may be authenticated under a
custom config dir interactively but unauthenticated under `$HOME/.claude`, which
is what beamup will use. Verify with:

```bash
ssh <host> 'cd /tmp && claude -p "say READY"'
```

If that fails to authenticate, run `ssh -t <host> "claude auth login"` first.
This is the single most likely reason Phase 4 fails, and it is a real product
finding worth reporting if the error message is unhelpful.

---

## Phase 0 — smoke

```bash
node bin/beamup.mjs --help
node bin/beamup.mjs doctor
node bin/beamup.mjs devices
npm test
```

Expected: help renders; `devices` lists `local` plus hosts from your
`~/.ssh/config`; **12/12** unit tests pass.

## Phase 1 — a conversation moves between folders (no second machine)

```bash
BEAMUP_HOST=nonexistent node test/e2e.mjs A
```

Expected: **2/2 passed**. This proves a real Claude Code conversation survives a
move and recalls its context. If this fails, stop and report — nothing else will
work.

## Phase 2 — SSH machinery

```bash
BEAMUP_HOST=<your-machine-B> node test/e2e.mjs
```

Expected: **5/5 passed**. This covers shipping the transcript, carrying
uncommitted work out, and bringing both back.

## Phase 3 — shell integration

```bash
node bin/beamup.mjs install-shell --rc /tmp/testrc --shell zsh
cat /tmp/testrc
node bin/beamup.mjs install-shell --rc /tmp/testrc --shell zsh   # idempotent
node bin/beamup.mjs uninstall-shell --rc /tmp/testrc --shell zsh
cat /tmp/testrc   # must be byte-identical to before
```

Then check it works for real, against your actual shell:

```bash
node bin/beamup.mjs install-shell
exec $SHELL
type claude              # should say: claude is a function
command claude --version # should still reach the real binary
beamup uninstall-shell
```

---

## Phase 4 — THE UNVERIFIED ONE: a real interactive beam

**This is the main event.** Nothing has ever run a model call on a remote
machine through this tool.

Set up two throwaway repos at the same commit:

```bash
# on A
mkdir -p /tmp/beamup-demo && cd /tmp/beamup-demo
git init -q && echo "original" > file.txt
git add -A && git -c user.email=t@t -c user.name=t commit -qm base
git log -1 --format=%H     # note the commit

# put a clone on B at the same commit, e.g.
ssh <host> 'mkdir -p /tmp/beamup-demo'
git push <host>:/tmp/beamup-demo-origin HEAD 2>/dev/null || \
  ssh <host> 'cd /tmp && git clone -q /path/or/copy beamup-demo'
```

(Any method is fine — the requirement is only that B's checkout is on the **same
commit** as A's.)

Then, on A, with an uncommitted change:

```bash
cd /tmp/beamup-demo
echo "edited on machine A" > file.txt
node /path/to/beamup/bin/beamup.mjs
```

In the session:

1. Say: `Remember the codeword PLATYPUS.`
2. Run: `/beam <host>:/tmp/beamup-demo`
3. **Watch what happens to your terminal.** Record it.
4. Once you're on B, ask: `What was the codeword? And what does file.txt contain?`
5. Have it create a file: `Write a file called from-B.txt containing "made on B".`
6. Run: `/beam home`
7. Ask: `What was the codeword?`
8. Exit.

**Report specifically:**

- Did `/beam` work as typed, or did you need `/beamup:beam`? *(The
  short form is unverified — this is a known open question.)*
- Did the remote session **visually redraw the earlier conversation**, or did you
  land at an empty prompt that merely remembered things?
- Did it recall `PLATYPUS` on B? Did it see `edited on machine A` in `file.txt`?
- After `/beam home`: is `from-B.txt` present on A? Does `file.txt` still say
  `edited on machine A`? Did it still recall `PLATYPUS`?
- How long did each transition take? Was there any confusing dead air?
- Was it ever unclear which machine you were on?

Finally, confirm nothing was orphaned on B:

```bash
ssh <host> 'ls ~/.beamup'
```

## Phase 5 — THE OTHER UNVERIFIED ONE: the interactive picker

Run `beamup`, then `/beam` **with no arguments**. You should get a
machine list, then a folder list.

If you can't drive a TUI directly, use tmux:

```bash
tmux new-session -d -s cct -x 200 -y 50 'node /path/to/beamup/bin/beamup.mjs'
sleep 5
tmux send-keys -t cct '/beam' Enter
sleep 8
tmux capture-pane -t cct -p        # screenshot the picker
tmux send-keys -t cct Down
tmux capture-pane -t cct -p        # did the highlight move?
tmux send-keys -t cct Enter
sleep 5
tmux capture-pane -t cct -p        # folder list?
tmux kill-session -t cct
```

**Report:** Does the machine list appear, and is `local` in it? Do arrow keys
move the selection? Does typing filter? Does Esc cancel cleanly and leave the
terminal usable? Does the folder list show branch and dirty-file counts? Is the
last-used folder pre-selected? **Paste the captured panes.**

## Phase 6 — failure modes

These should all fail *gracefully*, with a plain-language explanation and no
data loss. Report the exact wording — clarity is the feature here.

1. **Unreachable machine:** `/beam definitely-not-a-host:/tmp`
2. **Commit mismatch:** on B, `cd /tmp/beamup-demo && git commit --allow-empty -qm drift`,
   then beam there from A with a dirty file. It must **refuse to carry** and
   say which commit each side is on.
3. **Dirty destination:** make an uncommitted edit on B, then beam there with
   a dirty file on A. It must refuse rather than overwrite.
4. **Directory that doesn't exist on B:** `/beam <host>:/tmp/nope-not-here`

After each, verify **nothing was lost on either side**.

---

## Phase 7 — THE WHOLLY UNVERIFIED ONE: the cloud box

**Nothing in this phase has ever been run.** It was written against E2B's SDK
and docs but never executed, because the machine it was built on has no E2B
key. Treat every step as a hypothesis. You will need a key from
<https://e2b.dev/dashboard> — the free tier is enough.

The parts most likely to be wrong, in order:

1. **The PTY relay** (`src/cloud/pty.mjs`). E2B's PTY starts a shell with no way
   to hand it a command, so beamup writes the launch script to a file and sends
   `stty -echo; exec bash /tmp/beamup-launch.sh`. If the TUI renders garbled,
   doesn't clear, or ignores window resizes, this is the file.
2. **Provisioning** (`PROVISION_SCRIPT` in `src/cloud/setup.mjs`). It assumes
   E2B's `base` template has node, that `sudo apt-get` works for git, and that
   an `npm install -g` into `$HOME/.npm-global` succeeds. Any of those may be
   false; the exit codes 90–93 distinguish which.
3. **Sign-in inside the box.** The flow attaches a PTY running `claude` and then
   verifies with `claude -p ok`. If Claude Code's login flow needs something a
   sandbox can't do, fall back to option 2 (an API key).

```bash
node bin/beamup.mjs cloud            # first-run setup, start to finish
node bin/beamup.mjs devices          # cloud should read `paused`
node bin/beamup.mjs doctor cloud     # claude / node / git all found?
```

Then, from a git repo with an uncommitted edit:

1. Run `node bin/beamup.mjs`, make an edit, then `/beam cloud`.
2. Does the conversation redraw? Is your uncommitted edit present in
   `~/work/<repo>` over there? Is it on the **same commit** as your laptop
   (`git rev-parse HEAD` on both)?
3. Have it create a file, then `/beam home`. Did the file come back?
4. Does it print `cloud paused — billing stopped`?
5. Check <https://e2b.dev/dashboard>: is the sandbox actually **paused**, not
   running? This is the one that costs money if it's wrong.
6. Kill the supervisor mid-session (`kill -9`) and check the dashboard again
   within the hour — `autoPause` should put it to sleep on its own.

**Report the E2B dashboard state after every phase.** A box left running is the
worst bug this feature can have.

---

## Report back

For each phase: pass / fail / didn't run, with the actual output. Then:

1. **Anything that lost or corrupted work** — highest priority by far.
2. **Whether `/beam` resolves without the `beamup:` prefix.**
3. **Whether the remote session visually redraws the conversation.**
4. Anything confusing, slow, or ugly in the UX — especially moments where you
   couldn't tell which machine you were on.
5. Exact error text for anything that failed, plus `beamup doctor <host>`.

Don't fix anything. Report it.
