'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const serviceWorkerSource = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'extension', 'service-worker.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} source should exist`);
  const signatureMatch = new RegExp(`function\\s+${name}\\s*\\([^]*?\\)\\s*\\{`).exec(source.slice(start));
  assert.notEqual(signatureMatch, null, `${name} signature should include a body`);
  const bodyStart = start + signatureMatch[0].length - 1;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).trim();
  }
  assert.fail(`${name} body should end`);
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
    this.clientLeft = attrs.clientLeft || 0;
    this.clientTop = attrs.clientTop || 0;
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
  const topWindow = { screenX: 0, screenY: 0, MouseEvent: FakeEvent, PointerEvent: FakeEvent };
  const document = {
    defaultView: topWindow,
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
  topWindow.parent = topWindow;
  topWindow.frameElement = null;
  body.ownerDocument = document;
  for (const el of [target, ...target.children]) el.ownerDocument = document;

  const sandbox = {
    document,
    window: topWindow,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    globalThis: {}
  };
  vm.runInNewContext(`globalThis.api = { performClick: (${extractFunction(serviceWorkerSource, 'performClick')}), resolveClickTargetForCdp: (${extractFunction(serviceWorkerSource, 'resolveClickTargetForCdp')}) };`, sandbox);
  return sandbox.globalThis.api;
}

function loadFrameRuntime({ target, frameHit = target, topHit } = {}) {
  const iframe = new FakeElement('iframe', { id: 'frame', rect: { left: 100, top: 50, width: 300, height: 180 } });
  const topBody = new FakeElement('body');
  const frameBody = new FakeElement('body');
  const topWindow = { screenX: 5, screenY: 7, MouseEvent: FakeEvent, PointerEvent: FakeEvent };
  const frameWindow = { screenX: 5, screenY: 7, MouseEvent: FakeEvent, PointerEvent: FakeEvent, parent: topWindow, frameElement: iframe };
  const topDocument = {
    defaultView: topWindow,
    activeElement: topBody,
    querySelector() { return null; },
    elementFromPoint() { return topHit || iframe; }
  };
  const frameDocument = {
    defaultView: frameWindow,
    activeElement: frameBody,
    querySelector(selector) { return selector === '#target' ? target : null; },
    elementFromPoint() { return frameHit; }
  };
  topWindow.parent = topWindow;
  topWindow.frameElement = null;
  topWindow.__browserControlAgentRef = {
    resolve(ref) {
      return ref === '@e1_1' ? { element: target } : { error: `Element not found: ${ref}` };
    }
  };
  topBody.ownerDocument = topDocument;
  frameBody.ownerDocument = frameDocument;
  iframe.ownerDocument = topDocument;
  target.ownerDocument = frameDocument;
  for (const child of target.children) child.ownerDocument = frameDocument;

  const sandbox = {
    document: topDocument,
    window: topWindow,
    MouseEvent: FakeEvent,
    PointerEvent: FakeEvent,
    globalThis: {}
  };
  vm.runInNewContext(`globalThis.api = { performClick: (${extractFunction(serviceWorkerSource, 'performClick')}), resolveClickTargetForCdp: (${extractFunction(serviceWorkerSource, 'resolveClickTargetForCdp')}) };`, sandbox);
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

test('dom_pointer click targets same-origin iframe elements with frame-local events', () => {
  const target = new FakeElement('button', { id: 'target', textContent: 'Inside frame' });
  const api = loadFrameRuntime({ target });

  const result = api.performClick('@e1_1', { strategy: 'dom_pointer' });

  assert.equal(result.clicked, true);
  assert.equal(result.hitTest.hitWithinTarget, true);
  assert.equal(result.hitTest.frameDepth, 1);
  assert.equal(result.hitTest.frameClientX, 60);
  assert.equal(result.hitTest.frameClientY, 35);
  assert.equal(result.hitTest.topClientX, 160);
  assert.equal(result.hitTest.topClientY, 85);
  assert.equal(result.hitTest.topHit.tag, 'iframe');
  assert.equal(target.events.find(event => event.type === 'click').clientX, 60);
  assert.equal(target.events.find(event => event.type === 'click').screenX, 165);
  assert.equal(target.bubbledClickCount, 1);
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
  assert.equal(target.bubbledClickCount, 1);
});

test('dom_pointer click distinguishes iframe-internal and top-page covers', () => {
  const target = new FakeElement('button', { id: 'target' });
  const innerCover = new FakeElement('div', { id: 'inner-cover' });
  const topCover = new FakeElement('div', { id: 'top-cover' });

  const innerBlocked = loadFrameRuntime({ target, frameHit: innerCover }).performClick('@e1_1', { strategy: 'dom_pointer' });
  assert.equal(innerBlocked.code, 'COVERED_TARGET');
  assert.equal(innerBlocked.hitTest.coveredBy.id, 'inner-cover');
  assert.equal(innerBlocked.hitTest.frameHitWithinTarget, false);
  assert.equal(target.events.length, 0);

  const topBlocked = loadFrameRuntime({ target, topHit: topCover }).performClick('@e1_1', { strategy: 'dom_pointer' });
  assert.equal(topBlocked.code, 'COVERED_TARGET');
  assert.equal(topBlocked.hitTest.coveredBy.id, 'top-cover');
  assert.equal(topBlocked.hitTest.topHitWithinTarget, false);
  assert.equal(target.events.length, 0);
});

test('dom_pointer clickCount 2 dispatches a dblclick after two clicks', () => {
  const target = new FakeElement('button', { id: 'target' });
  const api = loadRuntime({ target });

  const result = api.performClick('#target', { strategy: 'dom_pointer', clickCount: 2 });

  assert.equal(result.clicked, true);
  assert.equal(target.events.filter(event => event.type === 'click').length, 2);
  assert.equal(target.events.filter(event => event.type === 'dblclick').length, 1);
  assert.equal(target.events.at(-1).type, 'dblclick');
  assert.equal(target.events.at(-1).detail, 2);
});

test('cdp target resolution returns top-frame coordinates for iframe elements', () => {
  const target = new FakeElement('button', { id: 'target', textContent: 'Inside frame' });
  const api = loadFrameRuntime({ target });

  const result = api.resolveClickTargetForCdp('@e1_1', {});

  assert.equal(result.strategyUsed, 'cdp_mouse');
  assert.equal(result.hitTest.hitWithinTarget, true);
  assert.equal(result.hitTest.clientX, 160);
  assert.equal(result.hitTest.clientY, 85);
  assert.equal(result.hitTest.frameClientX, 60);
  assert.equal(result.hitTest.frameDepth, 1);
  assert.equal(result.hitTest.topHit.tag, 'iframe');
});

test('dom_pointer is the only available DOM click strategy (element_click was removed)', () => {
  const target = new FakeElement('button', { id: 'target' });
  const api = loadRuntime({ target });

  const result = api.performClick('#target', { strategy: 'dom_pointer' });

  assert.equal(result.clicked, true);
  assert.equal(result.strategyUsed, 'dom_pointer');
  assert.equal(target.nativeClickCount, 0);
  assert.equal(target.bubbledClickCount, 1);
});
