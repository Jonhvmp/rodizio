import os from 'node:os';
import path from 'node:path';

// RODIZIO_HOME isolates everything; the tests and the demo use their own folder.
export function paths(home = process.env.RODIZIO_HOME || path.join(os.homedir(), '.rodizio')) {
  return {
    home,
    config: path.join(home, 'config.json'),
    state: path.join(home, 'state.json'),
    accounts: path.join(home, 'contas'),
    samples: path.join(home, 'amostras'),
    logs: path.join(home, 'logs'),
  };
}

export const claudeJsonPath = () => process.env.RODIZIO_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');

export const claudeSettingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');
