// Minimal Chrome DevTools Protocol client for beook's embedded Chromium (Equo/CEF).

export const DEBUG_PORT = Number(process.env.BEOOK_DEBUG_PORT || 9222);

export async function listPageTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
}

export async function isDebugPortUp() {
  try {
    await listPageTargets();
    return true;
  } catch {
    return false;
  }
}

export class CdpSession {
  static async open(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`Could not connect to beook view ${target.id}`));
    });
    return new CdpSession(ws, target);
  }

  constructor(ws, target) {
    this.ws = ws;
    this.target = target;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else entry.resolve(msg.result);
    };
    ws.onclose = () => {
      for (const { reject } of this.pending.values()) reject(new Error('beook view closed the connection'));
      this.pending.clear();
    };
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      throw new Error(ex.exception?.description || ex.text || 'Script error in beook view');
    }
    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

export async function withSession(target, fn) {
  const session = await CdpSession.open(target);
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}
