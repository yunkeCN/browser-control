'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const adrPath = path.join(root, 'docs', 'adr-action-observation-layer.md');
const apiPath = path.join(root, 'skills', 'browser-control', 'references', 'api.md');

test('action observation ADR covers required P1a design decisions', () => {
  const adr = fs.readFileSync(adrPath, 'utf8');
  for (const required of [
    'Status: Accepted; explicit lifecycle and action-coupled observation are implemented',
    'observe_start',
    'observe_diff',
    'Baseline storage',
    'Session and tab scoping',
    'Navigation invalidation',
    'Payload caps and artifact fallback',
    'Privacy and sensitive output',
    'Network/action marker semantics',
    'TextRuns extraction prototype notes',
    'Diff semantics prototype notes'
  ]) {
    assert.match(adr, new RegExp(escapeRegExp(required)), `${required} is required in observation ADR`);
  }
  assert.match(adr, /daemon memory/i);
  assert.match(adr, /session \+ tabId \+ baselineId/);
  assert.match(adr, /since marker/i);
});

test('API reference includes observation contract and ADR pointer', () => {
  const api = fs.readFileSync(apiPath, 'utf8');
  assert.match(api, /Observation commands/);
  assert.match(api, /observe_start/);
  assert.match(api, /observe_diff/);
  assert.match(api, /docs\/adr-action-observation-layer\.md/);
  assert.match(api, /requests since marker/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
