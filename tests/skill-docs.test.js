'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const skillDir = path.join(root, 'skills', 'browser-control');

function read(rel) {
  return fs.readFileSync(path.join(skillDir, rel), 'utf8');
}

test('skill instructions expose an actionable agent execution loop and references', () => {
  const skill = read('SKILL.md');
  assert.match(skill, /## Agent execution loop/);
  for (const phrase of [
    'Choose a unique `session` name',
    'Run `node scripts/browser-control.js doctor --json`',
    'Take a fresh `snapshot`',
    'Use `@e` references',
    'Stop and ask before sensitive',
    'Close task-specific tabs or sessions'
  ]) {
    assert.match(skill, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(skill, /references\/recipes\.md/);
  assert.match(skill, /references\/decision-guide\.md/);
});

test('recipes reference covers common browser automation tasks', () => {
  const recipes = read('references/recipes.md');
  for (const heading of [
    '## Read a page',
    '## Operate UI safely',
    '## Fill a form without submitting',
    '## Submit or confirm an action',
    '## Capture a screenshot',
    '## Save as PDF',
    '## Inspect network calls',
    '## Download a file',
    '## Clean up'
  ]) {
    assert.match(recipes, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(recipes, /@e/);
  assert.match(recipes, /screenshot\.sh/);
  assert.doesNotMatch(recipes, /base64 into context/i);
  assert.match(recipes, /first-class `scroll`/);
});

test('decision guide defines readiness, failure, escalation, and evidence rules', () => {
  const guide = read('references/decision-guide.md');
  for (const phrase of [
    'Daemon unreachable',
    'extension_connected=false',
    'BACKEND_UNAVAILABLE',
    'TIMEOUT',
    'Element not found',
    'MFA',
    'payment',
    'uploading files',
    'Reporting decisions'
  ]) {
    assert.match(guide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('skill instruction/reference docs remain English control material', () => {
  const files = [
    'SKILL.md',
    'references/api.md',
    'references/chrome-extension-setup.md',
    'references/troubleshooting.md',
    'references/recipes.md',
    'references/decision-guide.md'
  ];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /[\u4e00-\u9fff]/, `${file} should stay English for agent control semantics`);
  }
});
