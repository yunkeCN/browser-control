import type { CommandResult } from '@controller/types';
import type { DaemonStatus } from './daemon';

// ─── Helpers ───────────────────────────────────────────────────────

function el(selector: string): HTMLElement {
  return document.querySelector(selector)!;
}

function els(selector: string): NodeListOf<HTMLElement> {
  return document.querySelectorAll(selector);
}

function byteLength(text: string): number {
  if (window.TextEncoder) return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  for (let i = 0; i < units.length; i++) {
    if (value < 1024 || i === units.length - 1) {
      return value.toFixed(value >= 10 ? 1 : 2) + ' ' + units[i];
    }
    value /= 1024;
  }
  return bytes + ' B';
}

function formatClock(value: string | undefined): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatUptime(seconds: number): string {
  const total = Number(seconds) || 0;
  if (total < 60) return total + 's';
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + 'm';
  const hours = Math.floor(minutes / 60);
  return hours + 'h ' + (minutes % 60) + 'm';
}

function badge(text: string, className: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

function tableCell(content: string | Node): HTMLTableCellElement {
  const td = document.createElement('td');
  if (content instanceof Node) td.appendChild(content);
  else td.textContent = String(content);
  return td;
}

function emptyState(message: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'empty-state';
  node.textContent = message;
  return node;
}

function statusClass(code: number): string {
  if (code >= 500) return 'error';
  if (code >= 300) return 'warn';
  return 'ok';
}

// ─── Toast ─────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout>;

function getToast(): HTMLElement { return el('#toast'); }

export function showToast(message: string): void {
  const toast = getToast();
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

// ─── Connection pill ───────────────────────────────────────────────

export function setConnectionPill(kind: string, label: string): void {
  const pill = el('#connectionPill');
  pill.className = 'status-pill ' + kind;
  pill.textContent = label;
}

// ─── Status metrics ────────────────────────────────────────────────

export function renderStatus(data: DaemonStatus): void {
  el('#extensionMetric').textContent = data.extension_connected ? 'Connected' : 'Disconnected';
  el('#sessionsMetric').textContent = String(Array.isArray(data.sessions) ? data.sessions.length : 0);
  el('#pendingMetric').textContent = String(data.pendingRequests || data.pending_requests || 0);
  el('#uptimeMetric').textContent = formatUptime(data.uptime_seconds || data.uptimeSeconds || 0);
}

// ─── Sessions ──────────────────────────────────────────────────────

interface SessionInfo {
  name: string;
  tabCount: number;
  lastActivity: string;
}

function cleanSessionName(value: string): string {
  const cleaned = String(value || 'default').trim();
  return cleaned || 'default';
}

export function normalizeSessions(sessions: unknown): SessionInfo[] {
  if (!Array.isArray(sessions) || !sessions.length) {
    return [{ name: 'default', tabCount: 0, lastActivity: new Date().toISOString() }];
  }
  return sessions.map((s: unknown) => {
    if (typeof s === 'string') return { name: s, tabCount: 0, lastActivity: '' };
    const obj = s as Record<string, unknown>;
    return {
      name: cleanSessionName(obj.name as string),
      tabCount: Number(obj.tabCount || obj.tabs || 0),
      lastActivity: (obj.lastActivity || obj.createdAt || '') as string,
    };
  });
}

export function renderSessions(sessions: SessionInfo[], currentSession: string, onSelect: (name: string) => void): void {
  const list = el('#sessionList');
  list.replaceChildren();

  sessions.forEach((session) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-item';
    button.classList.toggle('active', session.name === currentSession);
    button.addEventListener('click', () => onSelect(session.name));

    const copy = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'session-name';
    name.textContent = session.name;
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = session.lastActivity ? 'last ' + formatClock(session.lastActivity) : 'no activity';
    copy.append(name, meta);

    const count = document.createElement('span');
    count.className = 'session-count';
    count.textContent = String(session.tabCount || 0);
    button.append(copy, count);
    list.appendChild(button);
  });
}

// ─── Presets ───────────────────────────────────────────────────────

interface Preset {
  command: string;
  title: string;
  meta: string;
}

const PRESETS: Preset[] = [
  { command: 'navigate', title: 'Open page', meta: 'navigate url' },
  { command: 'snapshot', title: 'Inspect DOM', meta: 'snapshot visible nodes' },
  { command: 'click', title: 'Click target', meta: 'target @e id' },
  { command: 'evaluate', title: 'Run script', meta: 'page runtime eval' },
  { command: 'network_start', title: 'Capture network', meta: 'session scope' },
  { command: 'network_list', title: 'Read network', meta: 'requests table' },
  { command: 'get_text', title: 'Extract text', meta: 'full text runs' },
];

export function renderPresets(activeCommand: string, onSelect: (command: string) => void): void {
  const list = el('#presetList');
  list.replaceChildren();
  PRESETS.forEach((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset-button';
    button.classList.toggle('active', preset.command === activeCommand);
    button.addEventListener('click', () => onSelect(preset.command));

    const title = document.createElement('div');
    title.className = 'preset-title';
    title.textContent = preset.title;
    const meta = document.createElement('div');
    meta.className = 'preset-meta';
    meta.textContent = preset.meta;
    button.append(title, meta);
    list.appendChild(button);
  });
}

// ─── Result ────────────────────────────────────────────────────────

function summaryCard(label: string, value: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = 'summary-card';
  const labelNode = document.createElement('span');
  labelNode.textContent = label;
  const valueNode = document.createElement('strong');
  valueNode.textContent = value;
  node.append(labelNode, valueNode);
  return node;
}

export function renderResult(
  result: CommandResult | null,
  rawResult: Record<string, unknown> | null,
  viewMode: 'daemon' | 'agent',
  duration: number | null,
  commandName: string,
  sessionName: string,
): void {
  const summaryEl = el('#resultSummary');
  const outputEl = el('#resultOutput');

  // Update view toggle active state
  els('[data-result-view]').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.resultView === viewMode);
  });

  if (!result) {
    summaryEl.replaceChildren();
    outputEl.textContent = '';
    return;
  }

  // Summary cards
  summaryEl.replaceChildren(
    summaryCard('Summary', result.summary),
    summaryCard('State', result.ok ? 'ok' : 'error'),
    summaryCard('Command', commandName),
    summaryCard('Session', sessionName),
    summaryCard('Duration', duration !== null ? duration + 'ms' : '--'),
    summaryCard('Data', result.data ? 'present' : 'none'),
  );

  // Output JSON
  let text: string;
  if (viewMode === 'agent') {
    text = JSON.stringify(result, null, 2);
  } else {
    text = rawResult ? JSON.stringify(rawResult, null, 2) : JSON.stringify(result, null, 2);
  }
  outputEl.textContent = text;

  const extra: string[] = [];
  if (result.nextSteps?.length) {
    extra.push(...result.nextSteps.map((s) => '→ ' + s));
  }
  // Append extra info after JSON
  if (extra.length) {
    outputEl.textContent += '\n\n' + extra.join('\n');
  }
}

// ─── History ───────────────────────────────────────────────────────

export interface HistoryItem {
  command: string;
  ok: boolean;
  duration: number | null;
  time: string;
}

export function renderHistory(items: HistoryItem[], expanded: boolean): void {
  const block = el('#historyBlock');
  const list = el('#historyList');
  const countEl = el('#historyCount');
  const toggleBtn = el('#toggleHistoryButton');

  block.classList.toggle('is-expanded', expanded);
  toggleBtn.setAttribute('aria-expanded', String(expanded));
  list.hidden = !expanded;
  (list as HTMLElement).tabIndex = expanded ? 0 : -1;

  countEl.textContent = String(items.length);
  list.replaceChildren();

  if (!items.length) {
    list.appendChild(emptyState('No command history yet.'));
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'history-item';
    const cmd = document.createElement('div');
    cmd.className = 'history-command';
    cmd.textContent = item.command;
    const status = document.createElement('div');
    status.className = 'history-status ' + (item.ok ? 'ok' : 'fail');
    status.textContent = item.ok ? 'OK' : 'FAIL';
    const time = document.createElement('div');
    time.className = 'history-time';
    time.textContent = formatClock(item.time) + (item.duration ? ' - ' + item.duration + 'ms' : '');
    row.append(cmd, status, time);
    list.appendChild(row);
  });
}

// ─── Tabs ──────────────────────────────────────────────────────────

export function setActiveTab(tab: string): void {
  els('.tab-button').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  els('.tab-panel').forEach((panel) => {
    const active = panel.id === 'panel-' + tab;
    panel.classList.toggle('active', active);
    (panel as HTMLElement).hidden = !active;
  });
}

// ─── Network ───────────────────────────────────────────────────────

interface NetworkRow {
  method: string;
  status: number | string;
  url: string;
  type: string;
  time: string;
}

export function renderNetwork(rows: NetworkRow[], filterQuery: string): void {
  const tbody = el('#networkTableBody');
  const query = filterQuery.trim().toLowerCase();

  const filtered = rows.filter((row) => {
    return !query || [row.method, row.status, row.url, row.type, row.time].join(' ').toLowerCase().includes(query);
  });

  tbody.replaceChildren();

  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.appendChild(emptyState(query ? 'No network rows match the current filter.' : 'No network data captured.'));
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  filtered.forEach((row) => {
    const tr = document.createElement('tr');
    tr.append(
      tableCell(badge(row.method || 'GET', 'method-badge')),
      tableCell(badge(String(row.status || '--'), 'status-badge ' + statusClass(Number(row.status)))),
      tableCell(row.url || '--'),
      tableCell(row.type || '--'),
      tableCell(row.time || '--'),
    );
    tbody.appendChild(tr);
  });
}

export function hydrateNetworkFromResult(result: Record<string, unknown> | null): NetworkRow[] {
  const data = result?.data as Record<string, unknown> | undefined;
  const requests = data?.requests || data?.entries || data?.items;
  if (!Array.isArray(requests)) return [];

  return requests.map((req: Record<string, unknown>) => {
    const status = req.status || req.statusCode || req.responseStatus || '--';
    const time = req.durationMs || req.elapsedMs || req.time || req.timestampMs;
    return {
      method: (req.method as string) || 'GET',
      status: status as number | string,
      url: (req.url || req.requestUrl || req.href || '--') as string,
      type: (req.type || req.resourceType || req.initiatorType || '--') as string,
      time: typeof time === 'number' ? Math.round(time) + 'ms' : String(time || '--'),
    };
  });
}

// ─── Logs ──────────────────────────────────────────────────────────

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  time: string;
}

export function renderLogs(entries: LogEntry[], filterLevel: string): void {
  const list = el('#logList');
  list.replaceChildren();

  const filtered = entries.filter((log) => filterLevel === 'all' || log.level === filterLevel);

  if (!filtered.length) {
    list.appendChild(emptyState('No logs in this view.'));
    return;
  }

  filtered.forEach((log) => {
    const row = document.createElement('div');
    row.className = 'log-row';
    const time = document.createElement('div');
    time.className = 'log-time';
    time.textContent = formatClock(log.time);
    const level = badge(log.level, 'level-badge ' + log.level);
    const message = document.createElement('div');
    message.className = 'log-message';
    message.textContent = log.message;
    row.append(time, level, message);
    list.appendChild(row);
  });
}

// ─── Validation ────────────────────────────────────────────────────

export function setValidation(message: string, type: string): void {
  const msgEl = el('#validationMessage');
  msgEl.textContent = message;
  msgEl.className = 'validation-message' + (type ? ' ' + type : '');
}

// ─── Button busy ───────────────────────────────────────────────────

export function setButtonBusy(busy: boolean): void {
  const btn = el('#sendButton') as HTMLButtonElement;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
}

// ─── Copy to clipboard ─────────────────────────────────────────────

function fallbackCopy(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopy(text);
    }
    showToast('Copied to clipboard.');
  } catch {
    fallbackCopy(text);
    showToast('Copied to clipboard.');
  }
}
