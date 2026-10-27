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

/**
 * A Windows toast, shown as Windows PowerShell's (an app that is always registered to show them). The title and text
 * go in variables of the child's environment, never into the script, so nothing in them is read as code.
 */
const TOAST = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$n = $t.GetElementsByTagName('text')
$n.Item(0).AppendChild($t.CreateTextNode($env:RODIZIO_TITULO)) | Out-Null
$n.Item(1).AppendChild($t.CreateTextNode($env:RODIZIO_TEXTO)) | Out-Null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
`;

export function notifyWindows(title, text) {
  try {
    const env = { ...process.env, RODIZIO_TITULO: String(title), RODIZIO_TEXTO: String(text) };
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST], { stdio: 'ignore', env, windowsHide: true, detached: true });
    p.on('error', () => {});
    p.unref();
  } catch {
    // a notification is never worth failing for
  }
}

/** Notification Center on macOS, a toast on Windows. Elsewhere (a server with no screen) nothing: the dashboard has it. */
export const systemNotify = (platform = process.platform) => (platform === 'darwin' ? notifyMac : platform === 'win32' ? notifyWindows : () => {});
