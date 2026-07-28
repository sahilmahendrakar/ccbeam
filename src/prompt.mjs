/**
 * The few questions beamup ever asks.
 *
 * They all happen in the gap between sessions, where the supervisor owns the
 * terminal — the same window the picker lives in. Nothing here is asked twice:
 * every answer is either derivable next time or written to config.
 */
import readline from "node:readline";
import { bold, dim } from "./ui.mjs";

export async function ask(question, { default: fallback = "" } = {}) {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = fallback ? dim(` [${fallback}]`) : "";
    const answer = await rl.question(`  ${question}${hint} `);
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

/** Same, but nothing echoes — for anything key-shaped. */
export async function askSecret(question) {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const onKeypress = () => {
    // Repaint the prompt with nothing after it, so the secret never appears.
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`  ${question} `);
  };
  process.stdin.on("keypress", onKeypress);
  try {
    const answer = await rl.question(`  ${question} `);
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    process.stdin.off("keypress", onKeypress);
    rl.close();
  }
}

export async function confirm(question, { default: fallback = true } = {}) {
  const answer = await ask(`${question} ${dim(fallback ? "(Y/n)" : "(y/N)")}`, {
    default: fallback ? "y" : "n",
  });
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
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) return options[index];
  }
}
