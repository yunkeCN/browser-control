'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const contentSource = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'extension', 'content.js'), 'utf8');

function extractClickRuntime() {
  const start = contentSource.indexOf('function findElement');
  const end = contentSource.indexOf('function performFill', start);
  assert.ok(start > 0, 'findElement exists');
  assert.ok(end > start, 'performFill follows click runtime');
  return contentSource.slice(start, end);
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

class FakeElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName.toUpperCase();
    this.id = attrs.id || '';
    this.className = attrs.className || '';
    this.textContent = attrs.textContent || '';
    this.children = [];
    this.parent = null;
    this.events = [];
    this.nativeClickCount = 0;
    this.bubbledClickCount = 0;
    this.rect = attrs.rect || { left: 10, top: 20, width: 100, height: 30 };
    this.attributes = attrs.attributes || {};
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  contains(other) {
    if (other === this) return true;
    return this.children.some(child => child.contains(other));
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  scrollIntoView(options) {
    this.scrolledWith = options;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  click() {
    this.nativeClickCount += 1;
    this.bubbledClickCount += 1;
  }

  dispatchEvent(event) {
    this.events.push(event);
    if (event.type === 'click') this.bubbledClickCount += 1;
    if (event.bubbles && this.parent) this.parent.dispatchEvent(event);
    return true;
  }
}

function loadRuntime({ target, hit = target }) {
  const body = new FakeElement('body');
  const document = {
    activeElement: body,
    querySelector(selector) {
      if (selector === '#target' || selector === '[data-agent-id="@e1"]') return target;
      if (selector === '#child') return target.children[0] || null;
      return null;
    },
    elementFromPoint() {
      return hit;
    }
  };
  body.ownerDocument = document;
  for (const el of [target, ...target.children]) el.ownerDocument = document;

  const sandbox = {
    document,
    window: { screenX: 0, screenY: 0 },
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    globalThis: {}
  };
  vm.runInNewContext(`${extractClickRuntime()}\nglobalThis.api = { performClick, performDomPointerClick, performElementClick };`, sandbox);
  return sandbox.globalThis.api;
}

test('dom_pointer click dispatches one event sequence and never also calls native click', () => {
  const target = new FakeElement('button', { id: 'target', textContent: 'Toggle' });
  const api = loadRuntime({ target });

  const result = api.performClick('#target', { strategy: 'dom_pointer' });

  assert.equal(result.clicked, true);
  assert.equal(result.strategyUsed, 'dom_pointer');
  assert.equal(target.nativeClickCount, 0);
  assert.equal(target.bubbledClickCount, 1);
  assert.deepEqual(target.events.map(event => event.type), [
    'pointerover',
    'pointerenter',
    'mouseover',
    'mouseenter',
    'pointermove',
    'mousemove',
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'click'
  ]);
});

test('dom_pointer click dispatches to nested hit target and bubbles to parent once', () => {
  const target = new FakeElement('button', { id: 'target', textContent: 'Parent' });
  const child = target.appendChild(new FakeElement('span', { textContent: 'Child' }));
  const api = loadRuntime({ target, hit: child });

  const result = api.performClick('#target', { strategy: 'dom_pointer' });

  assert.equal(result.clicked, true);
  assert.equal(result.hitTest.hitWithinTarget, true);
  assert.equal(result.dispatchedTo.tag, 'span');
  assert.equal(child.events.filter(event => event.type === 'click').length, 1);
  assert.equal(target.bubbledClickCount, 1);
  assert.equal(target.nativeClickCount, 0);
});

test('dom_pointer click reports covered targets unless force is explicit', () => {
  const target = new FakeElement('button', { id: 'target' });
  const cover = new FakeElement('div', { id: 'cover' });
  cover.ownerDocument = null;
  const api = loadRuntime({ target, hit: cover });

  const blocked = api.performClick('#target', { strategy: 'dom_pointer' });
  assert.match(blocked.error, /covered/i);
  assert.equal(blocked.code, 'COVERED_TARGET');
  assert.equal(blocked.hitTest.coveredBy.id, 'cover');
  assert.equal(target.events.length, 0);

  const forced = api.performClick('#target', { strategy: 'dom_pointer', force: true });
  assert.equal(forced.clicked, true);
  assert.match(forced.warnings.join(' '), /force:true/);
  assert.equal(target.bubbledClickCount, 1);
});

test('element_click strategy is explicit and only calls native click', () => {
  const target = new FakeElement('button', { id: 'target' });
  const api = loadRuntime({ target });

  const result = api.performClick('#target', { strategy: 'element_click' });

  assert.equal(result.clicked, true);
  assert.equal(result.strategyUsed, 'element_click');
  assert.equal(target.nativeClickCount, 1);
  assert.equal(target.events.length, 0);
  assert.match(result.warnings.join(' '), /el\.click/);
});
