import { readFileSync } from 'node:fs';

export function readTaskInput(task, { stdinTask = false, isTTY = process.stdin.isTTY, read = readFileSync } = {}) {
  if (stdinTask && task) throw new Error("'-' must be the only task input token.");
  const shouldRead = stdinTask || isTTY !== true;
  const stdin = shouldRead ? String(read(0, 'utf8')).trim() : '';
  if (!task) return stdin;
  if (!stdin) return task;
  return task + '\n\n<stdin>\n' + stdin + '\n</stdin>';
}
