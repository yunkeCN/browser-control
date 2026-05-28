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
    // Commands with requiredOneOf need at least one of the listed fields
    const spec = COMMANDS[command];
    if (spec.requiredOneOf && !spec.requiredOneOf.some(f => args[f] !== undefined)) {
      args[spec.requiredOneOf[0]] = spec.requiredOneOf[0] === 'target' ? '@e1jm0sbb_1' : `${spec.requiredOneOf[0]}-value`;
    }
    const req = validateRequest(normalizeRequest({ command, args, session: 's1' }));
    assert.equal(req.command, command);
    assert.equal(req.session, 's1');
  }
});

test('protocol exposes unified target args and keeps action diagnostics', () => {
  const click = validateRequest(normalizeRequest({
    command: 'click',
    args: {
      target: '@e1abc_1',
      force: true
    }
  }));
  assert.equal(click.args.target, '@e1abc_1');
  assert.equal(click.args.force, true);
  assert.deepEqual(COMMANDS.click.required, []);
  assert.deepEqual(COMMANDS.click.requiredOneOf, ['target', 'text']);
  assert.deepEqual(COMMANDS.click.optional, ['target', 'text', 'x', 'y', 'roles', 'tabId', 'force', 'interceptRequests']);
  assert.equal(COMMANDS.click.strategies, undefined);
  assert.deepEqual(mapNetworkCommand('click', click.args), {
    command: 'click',
    args: { target: '@e1abc_1', force: true, selector: '@e1abc_1' }
  });

  const fill = validateRequest(normalizeRequest({
    command: 'fill',
    args: { target: '@e2abc_1', value: 'draft', strategy: 'native_setter', clear: true, commit: 'change', expectChange: false }
  }));
  assert.equal(fill.args.target, '@e2abc_1');
  assert.equal(fill.args.strategy, 'native_setter');
  assert.equal(fill.args.commit, 'change');
  assert.deepEqual(mapNetworkCommand('fill', fill.args), {
    command: 'fill',
    args: { ...fill.args, selector: '@e2abc_1' }
  });

  const press = validateRequest(normalizeRequest({
    command: 'press',
    args: { key: 'Enter', strategy: 'dom_keyboard', modifiers: ['Control'], expectChange: true, observeNewTab: true, expectNewTab: false }
  }));
  assert.equal(press.args.strategy, 'dom_keyboard');
  assert.equal(press.args.observeNewTab, true);
  assert.deepEqual(COMMANDS.press.strategies, ['auto', 'cdp_keyboard', 'dom_keyboard']);
});

test('target is a strict element action target with explicit CSS fallback', () => {
  const click = validateRequest(normalizeRequest({
    command: 'click',
    args: { target: '@e1abc_2' }
  }));
  assert.equal(click.args.target, '@e1abc_2');

  const press = validateRequest(normalizeRequest({
    command: 'press',
    args: { key: 'Enter', target: '@e2abc_1' }
  }));
  assert.equal(press.args.target, '@e2abc_1');
  assert.deepEqual(mapNetworkCommand('press', press.args), {
    command: 'press',
    args: { ...press.args, selector: '@e2abc_1' }
  });

  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'fill', args: { target: '#save', value: 'draft' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'target' &&
      /css=<selector>/.test(err.details?.expectedFormat)
  );
  assert.equal(mapNetworkCommand('click', validateRequest(normalizeRequest({ command: 'click', args: { target: 'css=#save' } })).args).args.selector, '#save');
  assert.equal(mapNetworkCommand('fill', validateRequest(normalizeRequest({ command: 'fill', args: { target: 'css=#save', value: 'draft' } })).args).args.selector, '#save');
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'fill', args: { value: 'draft' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'target'
  );
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'press', args: { key: 'Enter', elementRef: '@e1abc_1' } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'elementRef' &&
      /args\.target/.test((err.details?.hints || []).join(' '))
  );
});

test('click request interception and text coordinates are exposed only through click command parameters', () => {
  // click with request interception/observation parameter (MCP-exposed)
  const clickWithRequestInterception = validateRequest(normalizeRequest({
    command: 'click',
    args: {
      target: '@e1abc_1',
      interceptRequests: { filter: '/api/', includeBody: true }
    }
  }));
  assert.equal(clickWithRequestInterception.command, 'click');
  assert.equal(clickWithRequestInterception.args.target, '@e1abc_1');
  assert.deepEqual(clickWithRequestInterception.args.interceptRequests, { filter: '/api/', includeBody: true });
  assert.equal(COMMANDS.click.optional.includes('interceptRequests'), true);
  assert.equal(COMMANDS.click.optional.includes('interceptAndObserveRequests'), false);
  assert.equal(COMMANDS.click.optional.includes('probe'), false);

  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click', args: { target: '@e1abc_1', probe: { filter: '/api/' } } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'probe' &&
      /interceptRequests/.test((err.details?.hints || []).join(' '))
  );

  const textClick = validateRequest(normalizeRequest({
    command: 'click',
    args: {
      text: 'Submit',
      x: 120,
      y: 240,
      roles: ['button']
    }
  }));
  assert.equal(textClick.command, 'click');
  assert.equal(textClick.args.text, 'Submit');
  assert.equal(textClick.args.x, 120);
  assert.equal(textClick.args.y, 240);
  assert.deepEqual(textClick.args.roles, ['button']);

  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click', args: { text: 'Submit', x: '120', y: 240 } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'x'
  );

  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click_probe', args: { target: '@e1abc_1' } })),
    err => err instanceof ProtocolError &&
      err.code === 'UNKNOWN_COMMAND'
  );
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'cdp_click_at', args: { x: 120, y: 240 } })),
    err => err instanceof ProtocolError &&
      err.code === 'UNKNOWN_COMMAND'
  );
});

test('protocol docs and TypeScript contracts expose action observe options and navigate result shape', () => {
  const root = path.resolve(__dirname, '..');
  const contracts = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'contracts.ts'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'api.md'), 'utf8');

  // click in contracts: target?, text?, interceptRequests?, no after
  assert.match(contracts, /click:\s*\{[^}]*target\?:\s*ClickTarget/s);
  assert.match(contracts, /click:\s*\{[^}]*interceptRequests\?:\s*ClickRequestInterceptionOptions/s);
  assert.doesNotMatch(contracts.match(/click:\s*\{[^}]+}/s)?.[0] || '', /after\?/);
  // ClickRequestInterceptionOptions interface exists with request interception fields
  assert.match(contracts, /export interface ClickRequestInterceptionOptions/);
  for (const option of ['filter', 'includeHeaders', 'includeBody', 'redactSensitive', 'maxRequests']) {
    assert.match(contracts, new RegExp(`ClickRequestInterceptionOptions[\\s\\S]*?${option}\\??:\\s*`));
  }
  // click_probe is not part of the public or daemon protocol.
  assert.doesNotMatch(contracts, /click_probe:/);
  // fill has required target
  assert.match(contracts, /fill:\s*\{\s*target:\s*ElementTarget/s);
  for (const command of ['press', 'scroll']) {
    assert.match(contracts, new RegExp(`${command}: \\{[^}]*target\\?:\\s*ElementTarget`, 's'));
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
  // request interception is documented inline in the click section, not as a standalone command.
  assert.match(api, /interceptRequests.*not a full dry run/s);
  assert.match(api, /Arguments: `target` or `text` required/);
  assert.match(api, /postSnapshot/);
  assert.doesNotMatch(contracts, /urlContains|titleContains/);
  assert.doesNotMatch(api, /urlContains|titleContains/);
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
    () => validateRequest(normalizeRequest({ command: 'fill', args: { target: '@e1abc_1', text: 'hello' } })),
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
  const req = validateRequest(normalizeRequest({ command: 'save_as_pdf', session: 's2' }));
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

test('daemon-internal network commands map to extension network command shape', () => {
  assert.deepEqual(mapNetworkCommand('network_list', { filter: '/api' }), { command: 'network', args: { filter: '/api', cmd: 'list' } });
  assert.deepEqual(mapNetworkCommand('network_detail', { requestId: 'r1' }), { command: 'network', args: { requestId: 'r1', cmd: 'detail' } });
});

test('network filter validation rejects non-string filters before extension dispatch', () => {
  // MCP-exposed network command requires action
  assert.throws(() => validateRequest(normalizeRequest({ command: 'network', args: {} })), err => err instanceof ProtocolError && err.code === 'VALIDATION_ERROR');

  // filter validation on network command
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'network', args: { action: 'list', filter: {} } })),
    err => err instanceof ProtocolError &&
      err.code === 'VALIDATION_ERROR' &&
      err.details?.field === 'filter' &&
      err.details?.expectedType === 'string' &&
      err.details?.actualType === 'object' &&
      /URL substring/.test(err.details?.hint || '')
  );

  // Valid filter values on daemon-internal network_list
  assert.equal(validateRequest(normalizeRequest({ command: 'network_list', args: { filter: '/api/' } })).args.filter, '/api/');
  assert.equal(validateRequest(normalizeRequest({ command: 'network_list', args: { filter: '' } })).args.filter, '');
  assert.equal(validateRequest(normalizeRequest({ command: 'network_list', args: { filter: null } })).args.filter, null);
  const filteredList = validateRequest(normalizeRequest({ command: 'network_list', args: { tabId: 42, sinceTimestampMs: 123, limit: 2, method: 'POST', statusCode: 201 } }));
  assert.equal(filteredList.args.tabId, 42);
  assert.equal(filteredList.args.method, 'POST');
  assert.equal(filteredList.args.statusCode, 201);
});

test('public docs and contracts stay aligned with current command argument surface', () => {
  const root = path.resolve(__dirname, '..');
  const contracts = fs.readFileSync(path.join(root, 'contracts.ts'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'api.md'), 'utf8');
  const recipes = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'recipes.md'), 'utf8');
  const screenshotHelper = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'scripts', 'screenshot.js'), 'utf8');

  assert.doesNotMatch(api, /command <name>/);
  assert.doesNotMatch(api, /--args-file <path>/);
  assert.doesNotMatch(api, /--code-file <path>/);
  assert.match(api, /codeBase64/);
  assert.match(api, /download`: args `url` required/);
  assert.match(contracts, /download:\s*\{\s*url:\s*string;[^}]*saveAs\?:\s*boolean/s);
  assert.match(screenshotHelper, /current extension backend returns viewport capture/);
  // Network is now a unified command with action parameter; no separate network_list in MCP docs
  assert.match(api, /`network` with `action:"list"`: list captured requests/);
  assert.match(api, /`limit` is clamped to 1\.\.100/);
  // MCP-exposed network command in contracts
  assert.match(contracts, /network:\s*\{[^}]*action:\s*NetworkAction;[^}]*filter\?:\s*string;[^}]*limit\?:\s*number/s);
  assert.doesNotMatch(api, /includeResources/);
  assert.doesNotMatch(contracts, /includeResources/);
  assert.match(recipes, /snapshot --args '\{"session":"read-page","hasVisibleText":true,"viewportOnly":true\}'/);
  assert.match(api, /### `scroll`/);
  assert.match(api, /strategy.*wheel.*x.*y.*deltaY/s);
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
  for (const field of ['target', 'tabId', 'strategy', 'deltaX', 'deltaY', 'x', 'y', 'region', 'steps', 'block', 'behavior', 'waitMs']) {
    assert.equal(COMMANDS.scroll.optional.includes(field), true, `${field} should be listed for scroll`);
  }
  assert.equal(COMMANDS.scroll.optional.includes('selector'), false, 'selector is internal; public scroll uses target');
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
  // network_detail requires requestId; passing index triggers unknown-arg then missing-required
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'network_detail', args: {} })),
    err => err instanceof ProtocolError &&
      err.details?.field === 'requestId' &&
      Array.isArray(err.details?.optional)
  );
  // network command with index instead of requestId gets a hint
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'network', args: { action: 'detail', index: 0 } })),
    err => err instanceof ProtocolError &&
      err.details?.field === 'index' &&
      /requestId/.test((err.details?.hints || []).join(' '))
  );
  // observe_diff requires baselineId
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'observe_diff', args: {} })),
    err => err instanceof ProtocolError && err.details?.field === 'baselineId'
  );
  // click with unknown elementRef arg gets hint about args.target
  assert.throws(
    () => validateRequest(normalizeRequest({ command: 'click', args: { elementRef: '@e1abc_1' } })),
    err => err instanceof ProtocolError && /target/.test((err.details?.hints || []).join(' '))
  );
});

test('protocol command metadata lists documented optional args for file, tab, and artifact commands', () => {
  assert.equal(COMMANDS[['select', 'option'].join('_')], undefined);
  assert.equal(COMMANDS[['set', 'checked'].join('_')], undefined);
  assert.deepEqual(COMMANDS.upload.required, ['target', 'files']);
  assert.deepEqual(COMMANDS.upload.optional, ['tabId']);
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
