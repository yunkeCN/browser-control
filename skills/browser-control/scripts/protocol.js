'use strict';

const PROTOCOL_VERSION = '2026-05-19';
const RUNTIME_SCHEMA_VERSION = '2026-05-20';

const CLI_CAPABILITIES = [
  'commandEnvelope',
  'doctorRuntimeDiagnostics',
  'staleDaemonShapeDiagnostics',
  'actionObservationRequest',
  'navigateFinalMetadata',
  'argsFile',
  'codeFile',
  'scroll'
];

const DAEMON_CAPABILITIES = [
  'healthStatusRuntimeMetadata',
  'extensionHelloStorage',
  'actionObservation',
  'observe_start',
  'observe_diff',
  'artifactStore',
  'navigateFinalMetadataPassthrough',
  'get_text',
  'sessionNetworkCapture',
  'snapshotFilters'
];

const EXTENSION_CAPABILITY_HINTS = [
  'navigateFinalMetadata',
  'observe_capture',
  'observe_start',
  'observe_diff',
  'network',
  'cdpMouse',
  'cdpKeyboard',
  'cdpWheelScroll',
  'domPointer',
  'scroll',
  'get_text',
  'sessionNetworkCapture',
  'snapshotFilters'
];

const COMMANDS = {
  navigate: { required: ['url'], optional: ['newTab', 'timeoutMs'] },
  find_tab: { required: [], optional: ['urlIncludes', 'titleIncludes', 'active', 'tabId', 'attach'] },
  snapshot: { required: [], optional: ['tabId', 'maxDepth', 'roles', 'tags', 'hasVisibleText', 'textIncludes', 'viewportOnly', 'maxElements'], example: { tabId: 123, roles: ['button', 'link'], hasVisibleText: true, maxElements: 50 } },
  click: {
    required: ['selector'],
    optional: ['tabId', 'strategy', 'force', 'button', 'clickCount', 'modifiers', 'expectChange', 'observe', 'observeNewTab', 'expectNewTab'],
    example: { selector: '@e1jm0sbb_1', strategy: 'auto', expectChange: true },
    strategies: ['auto', 'cdp_mouse', 'dom_pointer', 'element_click']
  },
  fill: {
    required: ['selector', 'value'],
    optional: ['tabId', 'strategy', 'clear', 'commit', 'expectChange', 'observe'],
    strategies: ['native_setter', 'text_input', 'paste_like']
  },
  press: {
    required: ['key'],
    optional: ['tabId', 'selector', 'strategy', 'modifiers', 'expectChange', 'observe', 'observeNewTab', 'expectNewTab'],
    strategies: ['auto', 'cdp_keyboard', 'dom_keyboard']
  },
  scroll: {
    required: [],
    optional: ['tabId', 'selector', 'strategy', 'deltaX', 'deltaY', 'x', 'y', 'region', 'steps', 'block', 'behavior', 'waitMs'],
    example: { deltaY: 800, strategy: 'dom' },
    strategies: ['auto', 'dom', 'wheel']
  },
  select_option: { required: ['selector', 'value'], optional: ['tabId'] },
  set_checked: { required: ['selector', 'checked'], optional: ['tabId'] },
  wait_for: { required: [], optional: ['selector', 'text', 'state', 'timeoutMs', 'tabId', 'expression'] },
  evaluate: { required: ['code'], optional: ['tabId'], example: { code: 'return { title: document.title }' } },
  screenshot: { required: [], optional: ['tabId', 'format', 'quality', 'fullPage', 'file_name', 'fileName'] },
  save_as_pdf: { required: [], optional: ['tabId', 'paper_format', 'landscape', 'scale', 'print_background', 'file_name'] },
  observe_start: { required: [], optional: ['tabId', 'mode', 'baselineId', 'includeNetworkMarker', 'maxTextChars', 'maxTextRuns'], example: { includeNetworkMarker: true } },
  observe_diff: { required: ['baselineId'], optional: ['tabId', 'includeCurrent', 'includeNetwork', 'maxAdded', 'maxRemoved', 'maxSummaryChars', 'allowStaleNavigationDiff'], example: { baselineId: 'obs_...', includeNetwork: true } },
  network_start: { required: [], optional: ['filter', 'tabId', 'scope'], example: { scope: 'session' } },
  network_list: { required: [], optional: ['filter', 'sinceTimestampMs', 'limit', 'tabId', 'method', 'statusCode', 'type'], example: { filter: '/api/' } },
  network_detail: { required: ['requestId'], optional: [], example: { requestId: '<id from network_list>' } },
  network_stop: { required: [] },
  upload: { required: ['selector', 'files'], optional: ['tabId'] },
  download: { required: ['url'], optional: ['filename', 'saveAs'] },
  get_text: { required: [], optional: ['tabId', 'scope', 'maxChars', 'includeRuns', 'selector'], example: { scope: 'full', maxChars: 4000, includeRuns: true } },
  list_tabs: { required: [] },
  close_tab: { required: [], optional: ['tabId'] },
  close_session: { required: [] }
};

const LEGACY_ACTION_ALIASES = {
  saveAsPdf: 'save_as_pdf',
  selectOption: 'select_option',
  setChecked: 'set_checked',
  waitFor: 'wait_for',
  findTab: 'find_tab',
  getText: 'get_text',
  networkStart: 'network_start',
  networkList: 'network_list',
  networkDetail: 'network_detail',
  networkStop: 'network_stop'
};

class ProtocolError extends Error {
  constructor(code, message, details = undefined, retryable = false) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

function normalizeCommand(command) {
  return LEGACY_ACTION_ALIASES[command] || command;
}

function normalizeRequest(body = {}) {
  const rawCommand = body.command || body.action;
  let command = normalizeCommand(rawCommand);
  const args = body.args && typeof body.args === 'object' ? body.args : {};
  const normalizedArgs = { ...args };
  if (rawCommand === 'attach_tab' || rawCommand === 'attachTab') {
    command = 'find_tab';
    normalizedArgs.attach = true;
  }
  return {
    id: body.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    version: body.version || PROTOCOL_VERSION,
    session: body.session || 'default',
    command,
    action: command,
    args: normalizedArgs,
    timeoutMs: Number.isFinite(body.timeoutMs) ? body.timeoutMs : 30000
  };
}

function validateRequest(request) {
  if (!request.command) {
    throw new ProtocolError('VALIDATION_ERROR', 'command/action is required', { field: 'command' });
  }
  const spec = COMMANDS[request.command];
  if (!spec) {
    throw new ProtocolError('UNKNOWN_COMMAND', `Unknown command: ${request.command}`, {
      command: request.command,
      validCommands: Object.keys(COMMANDS)
    });
  }
  for (const field of spec.required) {
    if (request.args[field] === undefined || request.args[field] === null || request.args[field] === '') {
      throw new ProtocolError('VALIDATION_ERROR', `${field} is required for command '${request.command}'`, validationDetails(request, spec, field));
    }
  }
  validateKnownArgs(request, spec);
  if (request.command === 'set_checked' && typeof request.args.checked !== 'boolean') {
    throw new ProtocolError('VALIDATION_ERROR', 'checked must be a boolean for command \'set_checked\'', { field: 'checked' });
  }
  if (request.command === 'upload' && !Array.isArray(request.args.files)) {
    throw new ProtocolError('VALIDATION_ERROR', 'files must be an array for command \'upload\'', { field: 'files' });
  }
  validateOptionalStringArg(request, spec, 'filter', [
    'network_start',
    'network_list'
  ]);
  return request;
}

function validateKnownArgs(request, spec) {
  const allowed = new Set([...(spec.required || []), ...(spec.optional || [])]);
  const provided = Object.keys(request.args || {});
  const unknown = provided.filter(field => !allowed.has(field));
  if (!unknown.length) return;
  const field = unknown[0];
  let suggestion = nearestArgName(field, [...allowed]);
  const hints = [];
  if (suggestion) hints.push(`Unknown argument "${field}". Did you mean "${suggestion}"?`);
  if (request.command === 'find_tab' && (field === 'urlContains' || field === 'titleContains')) {
    suggestion = field === 'urlContains' ? 'urlIncludes' : 'titleIncludes';
    hints.unshift(`Use "${suggestion}" for find_tab substring matching.`);
  }
  if (request.command === 'fill' && field === 'text') {
    hints.unshift('Use args.value for fill. args.text is not part of the fill command protocol.');
  }
  if (request.command === 'network_detail' && field === 'index') {
    hints.unshift('Use args.requestId from network_list; numeric index is not part of the network_detail protocol.');
  }
  if (request.command === 'click' && field === 'text') {
    hints.unshift('click uses args.selector. Run snapshot and click an @e selector; semantic click_text is deferred.');
  }
  throw new ProtocolError('VALIDATION_ERROR', `Unknown argument '${field}' for command '${request.command}'`, {
    field,
    command: request.command,
    unknown,
    required: spec.required,
    optional: spec.optional || [],
    validArgs: [...allowed],
    provided,
    suggestion,
    hints,
    hint: hints[0] || undefined
  });
}

function nearestArgName(field, candidates) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = levenshtein(String(field), String(candidate));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const maxDistance = Math.max(2, Math.floor(String(field).length / 3));
  return bestDistance <= maxDistance ? best : null;
}

function levenshtein(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }
  return rows[a.length][b.length];
}

function validateOptionalStringArg(request, spec, field, commands) {
  if (!commands.includes(request.command)) return;
  if (!Object.prototype.hasOwnProperty.call(request.args || {}, field)) return;
  const value = request.args[field];
  if (value === undefined || value === null || value === '') return;
  if (typeof value === 'string') return;
  throw new ProtocolError('VALIDATION_ERROR', `${field} must be a string for command '${request.command}'`, {
    ...validationDetails(request, spec, field),
    expectedType: 'string',
    actualType: Array.isArray(value) ? 'array' : typeof value,
    hint: `Use args.${field} as a URL substring string, for example {"${field}":"/api/"}, or omit it for no filtering.`
  });
}

function validationDetails(request, spec, field) {
  const details = {
    field,
    command: request.command,
    required: spec.required,
    optional: spec.optional || [],
    example: spec.example || null,
    provided: Object.keys(request.args || {})
  };
  const hints = [];
  if (request.command === 'fill' && field === 'value' && request.args && Object.prototype.hasOwnProperty.call(request.args, 'text')) {
    hints.push('Use args.value for fill. args.text is not part of the fill command protocol.');
    details.receivedAlias = 'text';
    details.expectedAlias = 'value';
  }
  if (request.command === 'network_detail' && Object.prototype.hasOwnProperty.call(request.args || {}, 'index')) {
    hints.push('Use args.requestId from network_list; numeric index is not part of the network_detail protocol.');
  }
  if (request.command === 'observe_diff' && field === 'baselineId') {
    hints.push('Run observe_start first, then pass the returned baselineId to observe_diff.');
  }
  if (request.command === 'click' && Object.prototype.hasOwnProperty.call(request.args || {}, 'text')) {
    hints.push('click uses args.selector. Run snapshot and click an @e selector; semantic click_text is deferred.');
  }
  if (hints.length) {
    details.hints = hints;
    details.hint = hints[0];
  }
  return details;
}

function protocolErrorFrom(err, fallbackCode = 'BACKEND_ERROR') {
  if (err instanceof ProtocolError) return err;
  const message = err?.message || String(err);
  if (/observation baseline not found|baseline not found/i.test(message)) {
    return new ProtocolError('NOT_FOUND', message, {
      nextSteps: [
        'Run observe_start again for the active session tab.',
        'If navigation occurred, create a new baseline before retrying observe_diff.'
      ]
    }, true);
  }
  if (/element not found|no element/i.test(message)) {
    return new ProtocolError('NOT_FOUND', message, {
      nextSteps: [
        'Run snapshot again and use a fresh @e<structureId>_<revision> reference.',
        'If the page changed, wait_for the target text or selector before retrying.'
      ]
    }, true);
  }
  if (/no active tab/i.test(message)) {
    return new ProtocolError('BACKEND_UNAVAILABLE', message, {
      nextSteps: [
        'Run navigate to open a tab in this session, or find_tab with attach=true to reuse an existing tab.'
      ]
    }, true);
  }
  if (/extension.*not connected|not connected|disconnected/i.test(message)) {
    return new ProtocolError('BACKEND_UNAVAILABLE', message, {
      nextSteps: [
        'Run doctor --json to confirm daemon and extension readiness.',
        'Reload the Chrome extension if doctor reports extension_connected=false.'
      ]
    }, true);
  }
  const retryable = /timeout|temporarily/i.test(message);
  const code = /timeout/i.test(message) ? 'TIMEOUT' : retryable ? 'BACKEND_UNAVAILABLE' : fallbackCode;
  const details = retryable ? {
    nextSteps: ['Retry after wait_for or increase timeoutMs if the page is still loading.']
  } : undefined;
  return new ProtocolError(code, message, details, retryable);
}

function createResultEnvelope(request, { ok, backend = 'extension', tab = null, data = null, artifacts = [], error = null, diagnostics = null, startedAt, endedAt = new Date().toISOString() }) {
  const started = startedAt || endedAt;
  return {
    id: request.id,
    ok,
    command: request.command,
    backend,
    session: request.session,
    tab,
    startedAt: started,
    endedAt,
    durationMs: Math.max(0, new Date(endedAt).getTime() - new Date(started).getTime()),
    data,
    artifacts,
    error,
    diagnostics
  };
}

function mapNetworkCommand(command, args) {
  switch (command) {
    case 'network_start': return { command: 'network', args: { ...args, cmd: 'start' } };
    case 'network_list': return { command: 'network', args: { ...args, cmd: 'list' } };
    case 'network_detail': return { command: 'network', args: { ...args, cmd: 'detail' } };
    case 'network_stop': return { command: 'network', args: { ...args, cmd: 'stop' } };
    default: return { command, args };
  }
}

module.exports = {
  PROTOCOL_VERSION,
  RUNTIME_SCHEMA_VERSION,
  CLI_CAPABILITIES,
  DAEMON_CAPABILITIES,
  EXTENSION_CAPABILITY_HINTS,
  COMMANDS,
  ProtocolError,
  normalizeCommand,
  normalizeRequest,
  validateRequest,
  protocolErrorFrom,
  createResultEnvelope,
  mapNetworkCommand
};
