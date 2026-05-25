import http from 'node:http';
import { PROTOCOL_VERSION } from './protocol.js';

export interface BrowserControlEnvelope {
  id: string;
  version: string;
  session: string;
  command: string;
  args: Record<string, unknown>;
  timeoutMs: number;
}

export interface HttpJsonResponse<T = unknown> {
  status: number;
  data: T;
}

export interface DaemonClientOptions {
  host?: string;
  port?: number;
}

export class DaemonClient {
  readonly host: string;
  readonly port: number;

  constructor(options: DaemonClientOptions = {}) {
    this.host = options.host || process.env.BROWSER_CONTROL_HOST || '127.0.0.1';
    this.port = options.port || Number(process.env.BROWSER_CONTROL_PORT || 10087);
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  status(timeoutMs = 1000): Promise<HttpJsonResponse<Record<string, unknown>>> {
    return this.requestJson('GET', '/status', undefined, timeoutMs);
  }

  health(timeoutMs = 1000): Promise<HttpJsonResponse<Record<string, unknown>>> {
    return this.requestJson('GET', '/health', undefined, timeoutMs);
  }

  command(envelope: BrowserControlEnvelope): Promise<HttpJsonResponse<Record<string, unknown>>> {
    return this.requestJson('POST', '/command', envelope, envelope.timeoutMs + 1000);
  }

  buildEnvelope(command: string, input: Record<string, unknown>): BrowserControlEnvelope {
    const { session = 'default', timeoutMs = 30000, id, ...args } = input;
    return {
      id: typeof id === 'string' && id ? id : `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      version: PROTOCOL_VERSION,
      session: typeof session === 'string' && session ? session : 'default',
      command,
      args,
      timeoutMs: typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000
    };
  }

  requestJson<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 30000): Promise<HttpJsonResponse<T>> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path,
        method,
        timeout: timeoutMs,
        headers: payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        } : undefined
      }, (res) => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: (text ? JSON.parse(text) : null) as T });
          } catch (error) {
            reject(new Error(`Invalid JSON from Browser Control daemon ${method} ${path}: ${(error as Error).message}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout contacting Browser Control daemon ${method} ${path}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
