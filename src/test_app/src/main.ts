import type { CommandResult } from '@controller/types';
import { BrowserDaemon } from './daemon';
import { COMMAND_META } from './commands';
import {
  setConnectionPill,
  renderStatus,
  renderSessions,
  renderPresets,
  renderResult,
  renderHistory,
  renderNetwork,
  renderLogs,
  setActiveTab,
  setValidation,
  setButtonBusy,
  showToast,
  copyText,
  normalizeSessions,
  hydrateNetworkFromResult,
  type HistoryItem,
  type LogEntry,
  type NetworkRow,
} from './ui';

// ─── State ─────────────────────────────────────────────────────────

interface AppState {
  sessions: ReturnType<typeof normalizeSessions>;
  history: HistoryItem[];
  logs: LogEntry[];
  networkRows: NetworkRow[];
  activeTab: string;
  resultView: 'daemon' | 'agent';
  logFilter: string;
  lastResult: CommandResult | null;
  lastRawResult: Record<string, unknown> | null;
  lastDuration: number | null;
  lastCommandName: string;
}

const state: AppState = {
  sessions: [{ name: 'default', tabCount: 0, lastActivity: new Date().toISOString() }],
  history: [],
  logs: [],
  networkRows: [],
  activeTab: 'result',
  resultView: 'agent',
  logFilter: 'all',
  lastResult: null,
  lastRawResult: null,
  lastDuration: null,
  lastCommandName: '',
};

const daemon = new BrowserDaemon();

// ─── DOM refs ──────────────────────────────────────────────────────

function $(selector: string): HTMLElement {
  return document.querySelector(selector)!;
}

// ─── Command execution ─────────────────────────────────────────────

function populateCommands(): void {
  const select = $('#commandSelect') as HTMLSelectElement;
  Object.keys(COMMAND_META).forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });
}

function selectCommand(command: string): void {
  const meta = COMMAND_META[command] || COMMAND_META.navigate;
  ($('#commandSelect') as HTMLSelectElement).value = command;
  ($('#argsInput') as HTMLTextAreaElement).value = JSON.stringify(meta.example, null, 2);
  setValidation('', '');
  renderPresets(command, selectCommand);
}

function getEndpoint(): string {
  return ($('#endpointInput') as HTMLInputElement).value.trim().replace(/\/+$/, '');
}

function getSessionName(): string {
  const raw = ($('#sessionInput') as HTMLInputElement).value;
  const cleaned = String(raw || 'default').trim();
  return cleaned || 'default';
}

function validateEnvelope(showSuccess: boolean): { ok: boolean; message?: string; envelope?: { command: string; session: string; args: Record<string, unknown>; timeoutMs: number } } {
  const command = ($('#commandSelect') as HTMLSelectElement).value;
  const meta = COMMAND_META[command];
  if (!meta) return { ok: false, message: 'Unknown command: ' + command };

  let args: unknown;
  const rawArgs = ($('#argsInput') as HTMLTextAreaElement).value.trim();
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch (err: unknown) {
    return { ok: false, message: 'Args JSON is invalid: ' + (err instanceof Error ? err.message : String(err)) };
  }

  if (!args || Array.isArray(args) || typeof args !== 'object') {
    return { ok: false, message: 'Args JSON must be an object.' };
  }

  const argsObj = args as Record<string, unknown>;
  const missing = meta.required.filter((field) => argsObj[field] === undefined || argsObj[field] === null || argsObj[field] === '');
  if (missing.length) {
    return { ok: false, message: 'Missing required args: ' + missing.join(', ') + '.' };
  }

  const timeoutMs = Number(($('#timeoutInput') as HTMLInputElement).value);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    return { ok: false, message: 'Timeout must be at least 1000ms.' };
  }

  if (showSuccess) setValidation('Envelope is valid.', 'success');

  return {
    ok: true,
    envelope: {
      command,
      session: getSessionName(),
      args: argsObj,
      timeoutMs,
    },
  };
}

async function executeCommand(): Promise<void> {
  const parsed = validateEnvelope(false);
  if (!parsed.ok) {
    setValidation(parsed.message || 'Validation failed', 'error');
    addLog('error', parsed.message || 'Validation failed');
    return;
  }

  setValidation('Envelope is valid.', 'success');
  setButtonBusy(true);
  const started = performance.now();
  const meta = COMMAND_META[parsed.envelope!.command]!;

  try {
    const rawResult = await daemon.sendCommand(parsed.envelope!);
    const duration = Math.round(performance.now() - started);

    // Build CommandResult using controller-aligned toResult
    const result: CommandResult = rawResult.ok === false
      ? { ok: false, summary: '执行失败: ' + ((rawResult.error as Record<string, unknown>)?.message || '未知错误') }
      : meta.toResult(rawResult, parsed.envelope!.command);

    state.lastResult = result;
    state.lastRawResult = rawResult;
    state.lastDuration = duration;
    state.lastCommandName = parsed.envelope!.command;

    renderResult(result, rawResult, state.resultView, duration, parsed.envelope!.command, parsed.envelope!.session);

    // History
    state.history.unshift({
      command: parsed.envelope!.command,
      ok: result.ok,
      duration,
      time: new Date().toISOString(),
    });
    state.history = state.history.slice(0, 40);
    const historyExpanded = $('#historyBlock').classList.contains('is-expanded');
    renderHistory(state.history, historyExpanded);

    // Session
    upsertSession({ name: parsed.envelope!.session, tabCount: 0, lastActivity: new Date().toISOString() });
    renderSessions(state.sessions, getSessionName(), onSessionSelect);

    addLog(result.ok ? 'info' : 'error', parsed.envelope!.command + ' completed in ' + duration + 'ms.');

    // Network hydration
    const rows = hydrateNetworkFromResult(rawResult);
    if (rows.length) {
      state.networkRows = rows;
      renderNetwork(state.networkRows, ($('#networkFilterInput') as HTMLInputElement).value);
      setActiveTab('network');
    }

    if (!result.ok) setActiveTab('result');
  } catch (err: unknown) {
    const duration = Math.round(performance.now() - started);
    const message = err instanceof Error ? err.message : String(err);

    const failResult: CommandResult = {
      ok: false,
      summary: 'daemon 执行失败: ' + message,
      nextSteps: [
        '请运行 browser_control_status 或 browser_control_doctor 检查 daemon 状态',
        '如果 daemon 未运行，请等待自动启动或手动启动 daemon',
      ],
    };

    state.lastResult = failResult;
    state.lastRawResult = null;
    state.lastDuration = duration;
    state.lastCommandName = parsed.envelope!.command;

    renderResult(failResult, null, state.resultView, duration, parsed.envelope!.command, parsed.envelope!.session);

    state.history.unshift({
      command: parsed.envelope!.command,
      ok: false,
      duration,
      time: new Date().toISOString(),
    });
    state.history = state.history.slice(0, 40);
    const historyExpanded = $('#historyBlock').classList.contains('is-expanded');
    renderHistory(state.history, historyExpanded);

    addLog('error', parsed.envelope!.command + ' failed: ' + message);
    setActiveTab('result');
  } finally {
    setButtonBusy(false);
  }
}

// ─── Daemon status ─────────────────────────────────────────────────

async function refreshStatus(quiet: boolean): Promise<void> {
  setConnectionPill('loading', 'Checking');
  try {
    const data = await daemon.getStatus();
    state.sessions = normalizeSessions(data.sessions);
    setConnectionPill(data.extension_connected ? 'online' : 'offline', data.extension_connected ? 'Online' : 'No extension');
    renderStatus(data);
    renderSessions(state.sessions, getSessionName(), onSessionSelect);
    if (!quiet) addLog('info', 'Status refreshed from ' + daemon.getEndpoint() + '.');
  } catch (err: unknown) {
    setConnectionPill('offline', 'Offline');
    renderStatus({
      extension_connected: false,
      sessions: state.sessions,
      pendingRequests: 0,
      uptime_seconds: 0,
    });
    renderSessions(state.sessions, getSessionName(), onSessionSelect);
    if (!quiet) {
      const message = err instanceof Error ? err.message : String(err);
      addLog('warn', 'Status refresh failed: ' + message);
      showToast('Daemon status unavailable.');
    }
  }
}

// ─── Session helpers ───────────────────────────────────────────────

function upsertSession(next: { name: string; tabCount: number; lastActivity: string }): void {
  const name = next.name;
  const index = state.sessions.findIndex((s) => s.name === name);
  const merged = { name, tabCount: next.tabCount || 0, lastActivity: next.lastActivity || new Date().toISOString() };
  if (index >= 0) {
    state.sessions[index] = { ...state.sessions[index], ...merged };
  } else {
    state.sessions.unshift(merged);
  }
}

function onSessionSelect(name: string): void {
  ($('#sessionInput') as HTMLInputElement).value = name;
  renderSessions(state.sessions, name, onSessionSelect);
}

// ─── Logs ──────────────────────────────────────────────────────────

function addLog(level: 'info' | 'warn' | 'error', message: string): void {
  state.logs.unshift({ level, message, time: new Date().toISOString() });
  state.logs = state.logs.slice(0, 120);
  renderLogs(state.logs, state.logFilter);
}

// ─── Event binding ─────────────────────────────────────────────────

function bindEvents(): void {
  // Connection form
  $('#connectionForm').addEventListener('submit', (e) => {
    e.preventDefault();
    daemon.setEndpoint(getEndpoint());
    refreshStatus(false);
  });

  // Command select
  $('#commandSelect').addEventListener('change', () => {
    selectCommand(($('#commandSelect') as HTMLSelectElement).value);
  });

  // Command form submit
  $('#commandForm').addEventListener('submit', (e) => {
    e.preventDefault();
    executeCommand();
  });

  // Validate button
  $('#validateButton').addEventListener('click', () => {
    validateEnvelope(true);
  });

  // Copy envelope
  $('#copyEnvelopeButton').addEventListener('click', () => {
    const parsed = validateEnvelope(false);
    if (!parsed.ok) {
      setValidation(parsed.message || '', 'error');
      return;
    }
    copyText(JSON.stringify(parsed.envelope, null, 2));
  });

  // Copy result
  $('#copyResultButton').addEventListener('click', () => {
    const text = $('#resultOutput').textContent?.trim();
    if (!text) { showToast('No result to copy.'); return; }
    copyText(text);
  });

  // Result view toggle
  document.querySelectorAll('[data-result-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.resultView = (btn as HTMLElement).dataset.resultView as 'daemon' | 'agent';
      renderResult(state.lastResult, state.lastRawResult, state.resultView, state.lastDuration, state.lastCommandName, getSessionName());
    });
  });

  // New session
  $('#newSessionButton').addEventListener('click', () => {
    const name = 'session-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    upsertSession({ name, tabCount: 0, lastActivity: new Date().toISOString() });
    ($('#sessionInput') as HTMLInputElement).value = name;
    renderSessions(state.sessions, name, onSessionSelect);
    addLog('info', 'Created local session ' + name + '.');
  });

  // Clear history
  $('#clearHistoryButton').addEventListener('click', () => {
    state.history = [];
    renderHistory(state.history, false);
  });

  // Toggle history
  $('#toggleHistoryButton').addEventListener('click', () => {
    const expanded = !$('#historyBlock').classList.contains('is-expanded');
    renderHistory(state.history, expanded);
  });

  // Tab buttons
  document.querySelectorAll('.tab-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = (btn as HTMLElement).dataset.tab || 'result';
      setActiveTab(state.activeTab);
    });
  });

  // Network filter
  $('#networkFilterInput').addEventListener('input', () => {
    renderNetwork(state.networkRows, ($('#networkFilterInput') as HTMLInputElement).value);
  });

  // Refresh network
  $('#refreshNetworkButton').addEventListener('click', () => {
    ($('#commandSelect') as HTMLSelectElement).value = 'network_list';
    selectCommand('network_list');
    setActiveTab('network');
    executeCommand();
  });

  // Log filter
  document.querySelectorAll('[data-log-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.logFilter = (btn as HTMLElement).dataset.logFilter || 'all';
      document.querySelectorAll('[data-log-filter]').forEach((c) => c.classList.toggle('active', c === btn));
      renderLogs(state.logs, state.logFilter);
    });
  });

  // Clear logs
  $('#clearLogsButton').addEventListener('click', () => {
    state.logs = [];
    renderLogs(state.logs, state.logFilter);
  });
}

// ─── Initialization ────────────────────────────────────────────────

function init(): void {
  populateCommands();
  renderPresets('navigate', selectCommand);
  bindEvents();
  selectCommand('navigate');
  renderSessions(state.sessions, getSessionName(), onSessionSelect);
  renderNetwork(state.networkRows, '');
  renderHistory(state.history, false);
  renderLogs(state.logs, state.logFilter);
  renderStatus({
    extension_connected: false,
    sessions: [],
    pendingRequests: 0,
    uptime_seconds: 0,
  });
  addLog('info', 'Console initialized.');
  refreshStatus(true);
  setInterval(() => refreshStatus(true), 5000);
}

init();
