// Starting beook with Chromium remote debugging enabled.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEBUG_PORT, isDebugPortUp } from './cdp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function powershell(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export function beookExecutable() {
  if (process.env.BEOOK_EXE) return process.env.BEOOK_EXE;
  try {
    const uninstall = powershell(
      "(Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\beook-uninstall' -ErrorAction Stop).UninstallString",
    );
    const exe = path.join(path.dirname(uninstall.replace(/"/g, '')), 'beook.exe');
    if (fs.existsSync(exe)) return exe;
  } catch {
    // not installed system-wide; fall through
  }
  return 'C:\\Apps\\beook\\beook.exe';
}

export function isBeookRunning() {
  try {
    return powershell('@(Get-Process beook -ErrorAction SilentlyContinue).Count') !== '0';
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, intervalMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

export async function launchBeook({ restart = false } = {}) {
  if (await isDebugPortUp()) return 'beook is already running with the debug connection enabled.';

  if (isBeookRunning()) {
    if (!restart) {
      throw new Error(
        'beook is running but without the debug connection. Call beook_launch with restart=true to close and reopen it (your answers are saved by beook), or close beook yourself first.',
      );
    }
    // Close the main window like the user would, so beook saves and syncs normally.
    powershell('Get-Process beook -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }');
    const closed = await waitFor(() => !isBeookRunning(), 30000);
    if (!closed) throw new Error('beook did not close within 30 seconds (maybe a dialog is open). Close it manually and try again.');
  }

  const exe = beookExecutable();
  if (!fs.existsSync(exe)) throw new Error(`beook not found at ${exe}. Set BEOOK_EXE to the path of beook.exe.`);
  const child = spawn(exe, ['--launcher.appendVmargs', '-vmargs', `-Dchromium.remote_debugging_port=${DEBUG_PORT}`], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const up = await waitFor(isDebugPortUp, 90000);
  if (!up) throw new Error('beook started, but the debug connection did not come up within 90 seconds.');
  return `beook started with the debug connection on port ${DEBUG_PORT}.`;
}
