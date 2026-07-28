import readline from "node:readline";
import { dim, inverse } from "./ui.mjs";

const ESC = "";
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const CLEAR_DOWN = `${ESC}[J`;

/**
 * A small list picker for the gap between sessions.
 *
 * This is the one moment the supervisor genuinely owns the terminal — the
 * previous Claude Code has exited and the next has not started — which is why
 * the picker lives here and not in the conversation. Choosing where to go
 * should not cost a model round trip.
 */
export async function pick({ title, rows, render, footer, preselect = 0 }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (!rows.length) return null;

  let filter = "";
  let index = Math.max(0, Math.min(preselect, rows.length - 1));
  let visible = rows;
  let painted = 0;

  const matches = () => {
    const q = filter.toLowerCase();
    return q ? rows.filter((r) => render(r).text.toLowerCase().includes(q)) : rows;
  };

  const paint = () => {
    let out = "";
    if (painted) out += `${ESC}[${painted}A`;
    out += "\r" + CLEAR_DOWN;

    const head = filter ? `${title}  ${dim("⌕ " + filter)}` : title;
    out += `${head}\n`;
    for (let i = 0; i < visible.length; i++) {
      const { text } = render(visible[i]);
      out += i === index ? `${inverse(" " + padEnd(text) + " ")}\n` : `  ${text}\n`;
    }
    out += dim(footer ?? "↑↓ select · ⏎ confirm · type to filter · esc cancel") + "\n";

    painted = visible.length + 2;
    process.stdout.write(out);
  };

  const padEnd = (s) => {
    const width = Math.min(process.stdout.columns ?? 80, 100) - 4;
    const bare = stripAnsi(s);
    return bare.length >= width ? s : s + " ".repeat(width - bare.length);
  };

  visible = matches();
  process.stdout.write(HIDE);
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  paint();

  return new Promise((resolve) => {
    const finish = (value) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(Boolean(wasRaw));
      process.stdin.pause();
      if (painted) process.stdout.write(`${ESC}[${painted}A\r${CLEAR_DOWN}`);
      process.stdout.write(SHOW);
      resolve(value);
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return finish(null);
      if (key.name === "return" || key.name === "enter") return finish(visible[index] ?? null);

      if (key.name === "up") index = Math.max(0, index - 1);
      else if (key.name === "down") index = Math.min(visible.length - 1, index + 1);
      else if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        visible = matches();
        index = 0;
      } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
        filter += str;
        visible = matches();
        index = 0;
      } else return;

      if (!visible.length) {
        // Never leave the user staring at an empty list they can't escape.
        filter = filter.slice(0, -1);
        visible = matches();
      }
      index = Math.max(0, Math.min(index, visible.length - 1));
      paint();
    };

    process.stdin.on("keypress", onKey);
  });
}

export function stripAnsi(s) {
  return String(s).replace(new RegExp(`${ESC}\\[[0-9;]*[a-zA-Z]`, "g"), "");
}
