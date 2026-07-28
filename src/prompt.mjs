/**
 * The few questions ccbeam ever asks.
 *
 * They all happen in the gap between sessions, where the supervisor owns the
 * terminal — the same window the picker lives in. Nothing here is asked twice:
 * every answer is either derivable next time or written to config.
 *
 * Note the import. `node:readline`'s `question()` is callback-style and returns
 * undefined, so awaiting it yields undefined rather than an answer — and every
 * prompt here would throw on the first thing it tried to do with the result.
 * The promises variant is a separate module, and it is the one we want.
 */
import readline from "node:readline";
import { createInterface } from "node:readline/promises";
import { bold, dim } from "./ui.mjs";

export async function ask(question, { default: fallback = "" } = {}) {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = fallback ? dim(` [${fallback}]`) : "";
    // Race the answer against the stream closing. Without this, a terminal that
    // goes away mid-question leaves the promise pending forever — and `choose`,
    // which loops until it gets a valid answer, would spin on it.
    const answer = await Promise.race([
      rl.question(`  ${question}${hint} `),
      new Promise((resolve) => rl.once("close", () => resolve(null))),
    ]);
    if (answer === null) return null; // end of input, not an empty answer
    return String(answer).trim() || fallback;
  } finally {
    rl.close();
  }
}

/**
 * Same, but nothing legible echoes — for anything key-shaped.
 *
 * Read straight from the terminal in raw mode rather than through readline.
 * Masking a readline prompt means either fighting its own redraw or reaching
 * into a private method; reading the bytes ourselves is fewer moving parts and
 * cannot flash the secret on screen between renders. One bullet per character,
 * because a prompt that shows nothing at all reads as frozen when you paste
 * into it.
 */
export function askSecret(question) {
  if (!process.stdin.isTTY) return Promise.resolve("");

  return new Promise((resolve) => {
    let buf = "";
    const render = () => {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(`  ${question} ${dim("•".repeat(Math.min(buf.length, 48)))}`);
    };

    const wasRaw = process.stdin.isRaw;
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      process.stdin.off("data", onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };

    const onData = (chunk) => {
      // A pasted key arrives as a single chunk, so walk the whole thing rather
      // than assuming one keystroke per event.
      for (const ch of chunk.toString("utf8")) {
        const code = ch.codePointAt(0);
        if (code === 3) return done(""); // ^C — raw mode means no SIGINT for us
        if (ch === "\r" || ch === "\n") return done(buf.trim());
        if (code === 127 || code === 8) {
          buf = buf.slice(0, -1);
          continue;
        }
        if (code < 32) continue; // arrow keys and friends are not part of a key
        buf += ch;
      }
      render();
    };

    render();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function confirm(question, { default: fallback = true } = {}) {
  const answer = await ask(`${question} ${dim(fallback ? "(Y/n)" : "(y/N)")}`, {
    default: fallback ? "y" : "n",
  });
  if (answer === null) return fallback;
  return /^y/i.test(answer);
}

/** A short numbered menu, for when there are only two or three ways to go. */
export async function choose(title, options, { default: fallback = 0 } = {}) {
  if (!process.stdin.isTTY) return options[fallback];
  process.stdout.write(`\n  ${bold(title)}\n\n`);
  options.forEach((option, i) => {
    process.stdout.write(`    ${bold(String(i + 1))}  ${option.label}\n`);
    if (option.detail) process.stdout.write(`       ${dim(option.detail)}\n`);
  });
  process.stdout.write("\n");
  for (;;) {
    const answer = await ask("choose", { default: String(fallback + 1) });
    if (answer === null) return options[fallback]; // input ended; take the default
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
  }
}
