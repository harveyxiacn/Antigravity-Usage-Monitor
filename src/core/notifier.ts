import { spawn } from 'node:child_process';

export interface DesktopNotificationPayload {
  title: string;
  message: string;
}

function sanitizeForShell(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/["'`$<>|&;]/g, '').slice(0, 220);
}

/**
 * Fires a best-effort, non-blocking native OS notification (Windows / macOS / Linux).
 * Never throws and never holds the Node event loop open (unref'd child process).
 */
export function sendDesktopNotification(payload: DesktopNotificationPayload): boolean {
  const title = sanitizeForShell(payload.title);
  const message = sanitizeForShell(payload.message);
  if (!title || !message) return false;

  try {
    if (process.platform === 'win32') {
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$n = New-Object System.Windows.Forms.NotifyIcon;',
        '$n.Icon = [System.Drawing.SystemIcons]::Warning;',
        '$n.Visible = $true;',
        `$n.ShowBalloonTip(5000, '${title.replace(/'/g, '')}', '${message.replace(/'/g, '')}', [System.Windows.Forms.ToolTipIcon]::Warning);`,
        'Start-Sleep -Seconds 6;',
        '$n.Dispose();',
      ].join(' ');
      const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psScript], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    }

    if (process.platform === 'darwin') {
      const script = `display notification "${message}" with title "${title}"`;
      const child = spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    }

    if (process.platform === 'linux') {
      const child = spawn('notify-send', [title, message], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
