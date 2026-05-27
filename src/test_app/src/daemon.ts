export interface DaemonStatus {
  extension_connected: boolean;
  sessions: Array<{
    name: string;
    tabCount?: number;
    tabs?: number;
    lastActivity?: string;
    createdAt?: string;
  }>;
  pendingRequests?: number;
  pending_requests?: number;
  uptime_seconds?: number;
  uptimeSeconds?: number;
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:10087';

export class BrowserDaemon {
  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  }

  setEndpoint(url: string): void {
    this.endpoint = url.replace(/\/+$/, '');
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  async getStatus(): Promise<DaemonStatus> {
    const res = await fetch(`${this.endpoint}/status`);
    if (!res.ok) {
      throw new Error(`Status check failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async sendCommand(envelope: {
    command: string;
    session: string;
    args: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.endpoint}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message =
        data?.error?.message || `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    return data;
  }

  async restart(): Promise<void> {
    const res = await fetch(`${this.endpoint}/restart`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Restart failed: ${res.status} ${res.statusText}`);
    }
  }
}
