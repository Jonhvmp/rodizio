import { spawn } from 'node:child_process';

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function notifyMac(title, text) {
  const script = `display notification "${esc(text)}" with title "${esc(title)}" sound name "Glass"`;
  try {
    const p = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    // a notification is never worth failing for
  }
}
