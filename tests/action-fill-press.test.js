'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const serviceWorker = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'extension', 'service-worker.js'), 'utf8');

test('fill action exposes clear commit diagnostics and sensitive value redaction', () => {
  assert.match(serviceWorker, /function performFill\(selector, value, options = \{\}\)/);
  assert.match(serviceWorker, /options\?\.clear !== false/);
  assert.match(serviceWorker, /collapse\(false\)/);
  assert.match(serviceWorker, /options\?\.commit \|\| ['"]change['"]/);
  assert.match(serviceWorker, /beforeinput/);
  assert.match(serviceWorker, /commit\w* === ['\"]blur['\"]/);
  assert.match(serviceWorker, /commit\w* === ['\"]enter['\"]/);
  assert.match(serviceWorker, /redacted/);
  assert.match(serviceWorker, /password\|passwd\|token\|secret/);
  assert.match(serviceWorker, /strategyUsed/);
  assert.match(serviceWorker, /tag === ['"]input['"] \? HTMLInputElement\.prototype : HTMLTextAreaElement\.prototype/);
  assert.match(serviceWorker, /Fill verification failed/);
});

test('service-worker fill uses textarea native setter and verifies final value', () => {
  const textarea = createFakeControl('textarea');
  const document = createFakeDocument(textarea);
  const performFill = loadServiceWorkerPerformFill(document);
  const result = performFill('#textarea', 'draft text', {});

  assert.equal(result.filled, true);
  assert.equal(result.mode, 'value');
  assert.equal(result.after.value, 'draft text');
  assert.deepEqual(textarea.events.map(event => event.type), ['beforeinput', 'input', 'change']);
  assert.equal(textarea.setterCalls.join(','), 'textarea:,textarea:draft text');
});

test('service-worker fill returns an error when the value did not stick', () => {
  const textarea = createFakeControl('textarea', { ignoreValueSets: true });
  const document = createFakeDocument(textarea);
  const performFill = loadServiceWorkerPerformFill(document);
  const result = performFill('#textarea', 'draft text', {});

  assert.match(result.error, /Fill verification failed/);
  assert.equal(result.after.value, '');
});

test('press action reports strategy focus key code and modifier diagnostics', () => {
  assert.match(serviceWorker, /function focusPressTarget\(selector\)/);
  assert.match(serviceWorker, /function performPress\(key, selector, options = \{\}\)/);
  assert.match(serviceWorker, /preventScroll:\s*true/);
  assert.match(serviceWorker, /strategyUsed:\s*['"]cdp_keyboard['"]/);
  assert.match(serviceWorker, /strategyUsed:\s*options\?\.strategy \|\| ['"]dom_keyboard['"]/);
  assert.match(serviceWorker, /focusBefore/);
  assert.match(serviceWorker, /focusAfter/);
  assert.match(serviceWorker, /modifiers/);
  assert.match(serviceWorker, /altKey/);
  assert.match(serviceWorker, /ctrlKey/);
  assert.match(serviceWorker, /shiftKey/);
});

function loadServiceWorkerPerformFill(document) {
  const fnSource = extractFunction(serviceWorker, 'performFill');
  const context = createVmContext(document);
  vm.createContext(context);
  return vm.runInContext(`(${fnSource})`, context);
}

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

function createVmContext(document) {
  class FakeEvent {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  }

  class FakeInputEvent extends FakeEvent {}
  class FakeKeyboardEvent extends FakeEvent {}

  class FakeInputElement {}
  Object.defineProperty(FakeInputElement.prototype, 'value', {
    get() {
      return this._value || '';
    },
    set(nextValue) {
      this.setterCalls.push(`input:${nextValue}`);
      if (this.tagName !== 'INPUT') throw new TypeError('input setter used on non-input');
      if (!this.ignoreValueSets) this._value = String(nextValue);
    }
  });

  class FakeTextAreaElement {}
  Object.defineProperty(FakeTextAreaElement.prototype, 'value', {
    get() {
      return this._value || '';
    },
    set(nextValue) {
      this.setterCalls.push(`textarea:${nextValue}`);
      if (this.tagName !== 'TEXTAREA') throw new TypeError('textarea setter used on non-textarea');
      if (!this.ignoreValueSets) this._value = String(nextValue);
    }
  });

  Object.setPrototypeOf(document.control, document.control.tagName === 'TEXTAREA'
    ? FakeTextAreaElement.prototype
    : FakeInputElement.prototype);
  Object.assign(document.control, createFakeControlBase(document.control.kind, document.control.options, document));

  return {
    document,
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    KeyboardEvent: FakeKeyboardEvent,
    HTMLInputElement: FakeInputElement,
    HTMLTextAreaElement: FakeTextAreaElement
  };
}

function createFakeDocument(control) {
  const document = {
    activeElement: null,
    control,
    querySelector(selector) {
      return selector === '#textarea' || selector === '#input' ? control : null;
    }
  };
  control.ownerDocument = document;
  return document;
}

function createFakeControl(kind, options = {}) {
  const tagName = kind === 'textarea' ? 'TEXTAREA' : 'INPUT';
  return {
    kind,
    options,
    tagName,
    ignoreValueSets: Boolean(options.ignoreValueSets)
  };
}

function createFakeControlBase(kind, options, document) {
  return {
    kind,
    options,
    tagName: kind === 'textarea' ? 'TEXTAREA' : 'INPUT',
    ignoreValueSets: Boolean(options.ignoreValueSets),
    _value: '',
    setterCalls: [],
    events: [],
    isContentEditable: false,
    textContent: '',
    id: '',
    scrollIntoView() {},
    focus() {
      document.activeElement = this;
    },
    blur() {
      if (document.activeElement === this) document.activeElement = null;
    },
    dispatchEvent(event) {
      this.events.push(event);
      return true;
    },
    getAttribute(name) {
      return name === 'type' ? 'text' : null;
    }
  };
}
