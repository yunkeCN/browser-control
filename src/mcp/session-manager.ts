export class McpSessionManager {
  private activeSession: string;

  constructor(initialSession = createSessionId()) {
    this.activeSession = initialSession;
  }

  getActiveSession(): string {
    return this.activeSession;
  }

  setActiveSession(session: string): string {
    const trimmed = session.trim();
    if (!trimmed) throw new Error('Session must be a non-empty string.');
    this.activeSession = trimmed;
    return this.activeSession;
  }

  resolveSession(explicitSession?: unknown): string {
    if (typeof explicitSession === 'string' && explicitSession.trim()) {
      return this.setActiveSession(explicitSession);
    }
    return this.activeSession;
  }

  rotateSession(): string {
    this.activeSession = createSessionId();
    return this.activeSession;
  }
}

export function createSessionId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
