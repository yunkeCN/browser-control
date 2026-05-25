'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSourceModule } = require('./helpers/load-source-module');
const {
  COMMANDS,
  normalizeRequest,
  validateRequest,
  createResultEnvelope,
  mapNetworkCommand,
  protocolErrorFrom,
  ProtocolError
} = require('../skills/browser-control/scripts/protocol');
const { ArtifactStore, extractArtifacts } = loadSourceModule('src/daemon/artifact-store.ts');

test('protocol validates all supported command envelopes', () => {
  for (const command of Object.keys(COMMANDS)) {
    const args = {};
    for (const field of COMMANDS[command].required) {
      args[field] = field === 'files' ? ['fixture.txt'] : field === 'checked' ? true : field === 'target' ? '@e1jm0sbb_1' : `${field}-value`;
    }
    if (COMMANDS[command].requiredOneOf?.length) args.elementRef = '@e1jm0sbb_1';
    const req = validateRequest(normalizeRequest({ command, args, session: 's1' }));
    assert.equal(req.command, command);
    assert.equal(req.session, 's1');
  }
});

test('protocol exposes simplified click target/after and keeps non-click action diagnostics', () => {
  const click = validateRequest(normalizeRequest({
    command: 'click',
    args: {
      target: '@e1abc_1',
      after: 'snapshot'
    }
  }));
  assert.equal(click.args.target, '@e1abc_1');
  assert.equal(click.args.after, 'snapshot');
  assert.equal(COMMANDS.click.required.includes('target'), true);
  assert.deepEqual(COMMANDS.click.optional, ['tabId', 'after']);
  assert.equal(COMMANDS.click.requiredOneOf, undefined);
  assert.equal(COMMANDS.click.strategies, undefined);
  assert.deepEqual(mapNetworkCommand('click', click.args), {
    command: 'click',
    args: { target: '@e1abc_1', after: 'snapshot', selector: '@e1abc_1' }
  });

  const fill = validateRequest(normalizeRequest({
    command: 'fill',
    args: { elementRef: '@e2abc_1', value: 'draft', strategy: 'native_setter', clear: true, commit: 'change', expectChange: false }
  }));
  assert.equal(fill.args.selector, '@e2abc_1');
  assert.equal(fill.args.strategy, 'native_setter');
  assert.equal(fill.args.commit, 'change');

  const press = validateRequest(normalizeRequest({
    command: 'press',
    args: { key: 'Enter', strategy: 'dom_keyboard', modifiers: ['Control'], expectChange: true, observeNewTab: true, expectNewTab: false }
  }));
  assert.equal(press.args.strategy, 'dom_keyboard');
  assert.equal(press.args.observeNewTab, true);
  assert.deepEqual(COMMANDS.press.strategies, ['auto', 'cdp_keyboard', 'dom_keyboard']);
});

test('elementRef is a strict @e alias for element-targeting commands', () => {
  const click = validateRequest(normalizeRequest({
    command: 'click',
    args: { target: '@e1abc_2' }
  }));
  assert.equal(click.args.target, '@e1abc_2');

  const press = validateRequest(normalizeRequest({
    command: 'press',
    args: { key: 'Enter', elementRef: '@e2abc_1' }
  }));
  assert.equal(press.args.selector, '@e2abc_1');

  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click', args: { target: '#save' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'target' &&
      /css=<selector>/.test(err.details?.expectedFormat)
  );
  assert.equal(validateRequest(normalizeRequest({ command: 'click', args: { target: 'css=#save' } })).args.target, 'css=#save');
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'fill', args: { value: 'draft' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.requiredOneOf?.includes('elementRef')
  );
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click', args: { elementRef: '@e1abc_1' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'target' &&
      /args\.target/.test((err.details?.hints || []).join(' '))
  );
});

test('protocol validates click_probe args and keeps it separate from action observation', () => {
  const probe = validateRequest(normalizeRequest({
    command: 'click_probe',
    args: {
      selector: '@e1',
      strategy: 'cdp_mouse',
      force: true,
      button: 'left',
      clickCount: 1,
      modifiers: ['Shift'],
      observeNewTab: false,
      expectNewTab: false,
      waitMs: 1000,
      filter: '/api/',
      includeHeaders: true,
      includeBody: true,
      redactSensitive: true,
      maxRequests: 10
    }
  }));
  assert.equal(probe.command, 'click_probe');
  assert.equal(probe.args.filter, '/api/');
  assert.deepEqual(COMMANDS.click_probe.strategies, ['auto', 'cdp_mouse', 'dom_pointer', 'element_click']);
  assert.equal(COMMANDS.click_probe.optional.includes('expectChange'), false);
  assert.equal(COMMANDS.click_probe.optional.includes('observe'), false);

  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click_probe', args: { selector: '@e1', includeBody: 'yes' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'includeBody'
  );
});

test('protocol docs and TypeScript contracts expose action observe options and navigate result shape', () => {
  const root = path.resolve(__dirname, '..');
  const contracts = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'contracts.ts'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'api.md'), 'utf8');

  assert.match(contracts, /click:\s*\{\s*target:\s*ClickTarget;[^}]*after\?:\s*ClickAfter/s);
  for (const removed of ['force?:', 'clickCount?:', 'expectChange?:', 'observe?: ObserveOptions']) {
    assert.doesNotMatch(contracts.match(/click:\s*\{[^}]+}/s)?.[0] || '', new RegExp(removed.replace(/[?]/g, '\\?')));
  }
  for (const option of ['strategy', 'force', 'button', 'clickCount', 'modifiers', 'waitMs', 'filter', 'includeHeaders', 'includeBody', 'redactSensitive', 'maxRequests']) {
    assert.match(contracts, new RegExp(`click_probe: [^;\\n]*\\{[^}]*${option}`, 's'));
  }
  for (const option of ['strategy', 'clear', 'commit', 'expectChange', 'observe']) {
    assert.match(contracts, new RegExp(`fill: [^;\\n]*\\{[^}]*${option}`, 's'));
  }
  for (const option of ['strategy', 'modifiers', 'expectChange', 'observe', 'observeNewTab', 'expectNewTab']) {
    assert.match(contracts, new RegExp(`press: \\{[^}]*${option}`, 's'));
  }
  assert.match(contracts, /export interface ObserveOptions/);
  assert.match(contracts, /export type ElementRef/);
  assert.match(contracts, /export interface NavigateResult/);
  assert.match(contracts, /navigationComplete:\s*boolean/);
  assert.match(api, /Stable response fields:/);
  assert.match(api, /`click_probe`/);
  assert.match(api, /not a full dry run/);
  assert.match(api, /Arguments: `target` required, optional `tabId` and `after`/);
  assert.match(api, /post snapshot/);
  assert.doesNotMatch(contracts, /urlContains|titleContains/);
  assert.doesNotMatch(api, /urlContains|titleContains/);
  assert.match(api, /intentionally loose/);
});

test('protocol rejects invalid commands and missing required args with stable error codes', () => {
  assert.throws(() => validateRequest(normalizeRequest({ command: 'bogus' })), err => err instanceof ProtocolError && err.code === 'UNKNOWN_COMMAND');
  assert.throws(() => validateRequest(normalizeRequest({ command: 'navigate', args: {} })), err => err instanceof ProtocolError && err.code === 'VALIDATION_ERROR');
});

test('protocol rejects unknown args with canonical-name hints', () => {
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'find_tab', args: { urlContains: 'search.bilibili.com' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'urlContains' &&
      err.details?.suggestion === 'urlIncludes' &&
      /urlIncludes/.test((err.details?.hints || []).join(' '))
  );
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'snapshot', args: { maxElements: 10 } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'maxElements' &&
      Array.isArray(err.details?.validArgs) &&
      !err.details.validArgs.includes('maxElements')
  );
});

test('fill validation points agents from text to value', () => {
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'fill', args: { selector: '@e1', text: 'hello' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'value' &&
      err.details?.receivedAlias === 'text' &&
      /args\.value/.test(err.details?.hint || '')
  );
});

test('wait_for accepts text args as documented', () => {
  const req = validateRequest(normalizeRequest({ command: 'wait_for', args: { text: 'Ready', timeoutMs: 1000 } }));
  assert.equal(req.command, 'wait_for');
  assert.equal(req.args.text, 'Ready');
  assert.equal(req.args.timeoutMs, 1000);
});

test('backend errors include recoverable next steps for common agent failures', () => {
  const notFound = protocolErrorFrom(new Error('Element not found: @e99'));
  assert.equal(notFound.code, 'NOT_FOUND');
  assert.equal(notFound.retryable, true);
  assert.ok(notFound.details?.nextSteps?.length);

  const noTab = protocolErrorFrom(new Error('No active tab in session'));
  assert.equal(noTab.code, 'BACKEND_UNAVAILABLE');
  assert.equal(noTab.retryable, true);
  assert.match(noTab.details.nextSteps[0], /navigate|find_tab/);
});

test('result envelope contains stable agent-facing metadata', () => {
  const req = validateRequest(normalizeRequest({ action: 'saveAsPdf', session: 's2' }));
  const envelope = createResultEnvelope(req, {
    ok: true,
    startedAt: '2026-05-19T00:00:00.000Z',
    endedAt: '2026-05-19T00:00:01.000Z',
    data: { artifact: { path: '/tmp/page.pdf' } },
    artifacts: [{ kind: 'pdf', path: '/tmp/page.pdf' }],
    diagnostics: { extensionConnected: true }
  });
  assert.equal(envelope.command, 'save_as_pdf');
  assert.equal(envelope.backend, 'extension');
  assert.equal(envelope.durationMs, 1000);
  assert.equal(envelope.artifacts[0].kind, 'pdf');
  assert.equal(envelope.error, null);
  assert.ok(Object.keys(envelope).indexOf('artifacts') < Object.keys(envelope).indexOf('data'));
});

test('discrete network commands map to extension network command shape', () => {
  assert.deepEqual(mapNetworkCommand('network_start', { filter: '/api' }), { command: 'network', args: { filter: '/api', cmd: 'start' } });
  assert.deepEqual(mapNetworkCommand('network_stop', {}), { command: 'network', args: { cmd: 'stop' } });
});

test('network filter validation rejects non-string filters before extension dispatch', () => {
  assert.throws(() => validateRequest(normalizeRequest({ command: 'network', args: { cmd: 'list' } })), err => err instanceof ProtocolError && err.code === 'UNKNOWN_COMMAND');

  for (const command of ['network_start', 'network_list']) {
    assert.throws(
      () => validateRequest(normalizeRequest({ command, args: { filter: {} } })),
      err => err instanceof ProtocolError &&
        err.code === 'VALIDATION_ERROR' &&
        err.details?.field === 'filter' &&
        err.details?.expectedType === 'string' &&
        err.details?.actualType === 'object' &&
        /URL substring/.test(err.details?.hint || '')
    );
  }

  assert.equal(validateRequest(normalizeRequest({ command: 'network_list', args: { filter: '/api/' } })).args.filter, '/api/');
  assert.equal(validateRequest(normalizeRequest({ command: 'network_list', args: { filter: '' } })).args.filter, '');
  assert.equal(validateRequest(normalizeRequest({ command: 'network_list', args: { filter: null } })).args.filter, null);
  const filteredList = validateRequest(normalizeRequest({ command: 'network_list', args: { tabId: 42, sinceTimestampMs: 123, limit: 2, method: 'POST', statusCode: 201, type: 'fetch' } }));
  assert.equal(filteredList.args.tabId, 42);
  assert.equal(filteredList.args.method, 'POST');
  assert.equal(filteredList.args.statusCode, 201);
  assert.equal(filteredList.args.type, 'fetch');
});

test('public docs and contracts stay aligned with current command argument surface', () => {
  const root = path.resolve(__dirname, '..');
  const contracts = fs.readFileSync(path.join(root, 'contracts.ts'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'api.md'), 'utf8');
  const recipes = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'recipes.md'), 'utf8');
  const screenshotHelper = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'scripts', 'screenshot.js'), 'utf8');

  assert.match(api, /--args-file <path>/);
  assert.match(api, /--code-file <path>/);
  assert.match(api, /codeBase64/);
  assert.match(api, /download`: args `url` required/);
  assert.match(contracts, /download:\s*\{\s*url:\s*string;[^}]*saveAs\?:\s*boolean/s);
  assert.match(api, /fullPage:true.*forward compatibility/s);
  assert.match(screenshotHelper, /current extension backend returns viewport capture/);
  assert.match(api, /network_list`: list captured requests; optional args `filter`, `sinceTimestampMs`, `limit`, `tabId`, `method`, `statusCode`, and `type`/);
  assert.match(api, /`limit` is clamped to 1\.\.100/);
  assert.match(api, /omittedUntimestamped/);
  assert.match(contracts, /network_list:\s*\{[^}]*sinceTimestampMs\?:\s*number;[^}]*limit\?:\s*number;[^}]*tabId\?:\s*number;[^}]*method\?:\s*string;[^}]*statusCode\?:\s*number;[^}]*type\?:\s*string/s);
  assert.doesNotMatch(api, /includeResources/);
  assert.doesNotMatch(contracts, /includeResources/);
  assert.equal(COMMANDS.network_start.optional.includes('includeResources'), false);
  assert.match(recipes, /snapshot --session read-page --args '\{"hasVisibleText":true,"viewportOnly":true\}'/);
  assert.match(api, /### `scroll`/);
  assert.match(api, /strategy.*wheel.*x.*y.*deltaY/s);
  assert.match(api, /explicit wheel failures are recoverable/s);
  assert.match(api, /backward-compatible `document`/);
  assert.match(api, /Unknown fields fail validation/);
  assert.match(api, /newTab.*newTabs/);
  assert.match(recipes, /first-class `scroll` rather than keyboard keys or an `evaluate` workaround/);
  assert.match(api, /schemaVersion: 3/);
  assert.match(api, /playwright-aria-ai-v1/);
  assert.match(contracts, /interface SnapshotResult/);
  assert.match(contracts, /semantics:\s*'playwright-aria-ai-v1'/);
  assert.doesNotMatch(api, /navigate[\s\S]{0,250}optional `tabId`/);
  assert.doesNotMatch(contracts, /navigate:\s*\{[^}]*tabId/s);
});

test('artifact store persists raw outputs and returns metadata without base64 payload', () => {
  const store = new ArtifactStore(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-artifacts-')));
  const encoded = Buffer.from('pdf-body').toString('base64');
  const { data, artifacts } = extractArtifacts('save_as_pdf', { format: 'pdf', data: encoded, fileName: 'fixture.pdf' }, store);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].mimeType, 'application/pdf');
  assert.ok(fs.existsSync(artifacts[0].path));
  assert.equal(data.data, undefined);
});



test('protocol exposes first-class scroll command with DOM and wheel strategies', () => {
  assert.ok(COMMANDS.scroll, 'scroll should be protocol-visible');
  assert.deepEqual(COMMANDS.scroll.strategies, ['auto', 'dom', 'wheel']);
  for (const field of ['elementRef', 'tabId', 'selector', 'strategy', 'deltaX', 'deltaY', 'x', 'y', 'region', 'steps', 'block', 'behavior', 'waitMs']) {
    assert.equal(COMMANDS.scroll.optional.includes(field), true, `${field} should be listed for scroll`);
  }
  assert.equal(COMMANDS.scroll.optional.includes('mode'), false, 'mode is a legacy runtime override, not a public scroll option');
  const req = validateRequest(normalizeRequest({ command: 'scroll', args: { strategy: 'wheel', x: 100, y: 200, deltaY: 600 } }));
  assert.equal(req.command, 'scroll');
  assert.equal(req.args.strategy, 'wheel');
  const contracts = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'contracts.ts'), 'utf8');
  assert.match(contracts, /scroll:\s*\{[^}]*strategy\?:\s*'auto' \| 'dom' \| 'wheel'/s);
  assert.doesNotMatch(contracts, /mode\?:\s*'by' \| 'to' \| 'element'/);
  assert.match(contracts, /ArtifactKind[\s\S]*'observation'/);
});

test('protocol exposes usability optimization commands without codeBase64', () => {
  for (const command of ['get_text', 'find_tab']) {
    assert.ok(COMMANDS[command], `${command} should be protocol-visible`);
  }
  assert.equal(COMMANDS.get_text.optional.includes('selector'), true, 'get_text selector should be protocol-visible');
  assert.equal(COMMANDS.attach_tab, undefined);
  const legacyAttach = validateRequest(normalizeRequest({ command: 'attach_tab', args: { urlIncludes: 'example.com' } }));
  assert.equal(legacyAttach.command, 'find_tab');
  assert.equal(legacyAttach.args.attach, true);
  assert.equal(COMMANDS.evaluate.required.includes('code'), true);
  assert.doesNotMatch(JSON.stringify(COMMANDS), /codeBase64/);
  const api = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'skills/browser-control/references/api.md'), 'utf8');
  assert.match(api, /scope` \(`viewport` default, backward-compatible `document`, or rendered\/reachable `full`\)/);
  assert.match(api, /canonical `textRuns`/);
  assert.doesNotMatch(fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'contracts.ts'), 'utf8'), /codeBase64/);
});

test('validation details include optional fields, examples, and common recovery hints', () => {
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'network_detail', args: { index: 0 } })),
    err => err instanceof ProtocolError &&
      err.details?.field === 'requestId' &&
      Array.isArray(err.details?.optional) &&
      err.details?.example?.requestId &&
      /requestId/.test((err.details?.hints || []).join(' '))
  );
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'observe_diff', args: {} })),
    err => err instanceof ProtocolError && /observe_start/.test((err.details?.hints || []).join(' '))
  );
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click', args: { text: 'Save' } })),
    err => err instanceof ProtocolError && /snapshot/.test((err.details?.hints || []).join(' '))
  );
});

test('protocol command metadata lists documented optional args for file, tab, and artifact commands', () => {
  assert.equal(COMMANDS[['select', 'option'].join('_')], undefined);
  assert.equal(COMMANDS[['set', 'checked'].join('_')], undefined);
  assert.deepEqual(COMMANDS.upload.optional, ['elementRef', 'selector', 'tabId']);
  assert.deepEqual(COMMANDS.close_tab.optional, ['tabId']);
  for (const field of ['tabId', 'paper_format', 'landscape', 'scale', 'print_background', 'file_name']) {
    assert.equal(COMMANDS.save_as_pdf.optional.includes(field), true, `${field} should be listed for save_as_pdf`);
  }
  for (const field of ['filename', 'saveAs']) {
    assert.equal(COMMANDS.download.optional.includes(field), true, `${field} should be listed for download`);
  }
  for (const field of ['urlIncludes', 'titleIncludes', 'active', 'tabId', 'attach']) {
    assert.equal(COMMANDS.find_tab.optional.includes(field), true, `${field} should be listed for find_tab`);
  }
});
