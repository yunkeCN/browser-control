'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const serviceWorker = fs.readFileSync(path.join(root, 'skills/browser-control/extension/service-worker.js'), 'utf8');

function extractFunction(source, name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} source should exist`);
  if (source.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  const signatureMatch = new RegExp(`function\\s+${name}\\s*\\([^]*?\\)\\s*\\{`).exec(source.slice(start));
  assert.notEqual(signatureMatch, null, `${name} signature should include a body`);
  const bodyStart = start + signatureMatch.index + signatureMatch[0].length - 1;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1).trim();
  }
  assert.fail(`${name} body should end`);
}


function extractFunctionBlock(source, firstName, lastName) {
  const start = source.indexOf(`function ${firstName}(`);
  assert.notEqual(start, -1, `${firstName} source should exist`);
  const lastSource = extractFunction(source, lastName);
  const lastStart = source.indexOf(lastSource, start);
  assert.notEqual(lastStart, -1, `${lastName} source should be inside block`);
  return source.slice(start, lastStart + lastSource.length).trim();
}

function createTextSandbox({ count = 5 } = {}) {
  class FakeElement {
    constructor(tagName, attrs = {}, style = {}) {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.attrs = attrs;
      this.parentElement = null;
      this.hidden = false;
      this.style = { display: 'block', visibility: 'visible', opacity: '1', ...style };
      this.children = [];
      this.childNodes = [];
    }
    get id() { return this.attrs.id || ''; }
    get className() { return this.attrs.class || ''; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
    getClientRects() { return []; }
  }
  function makeText(text, y, parent) {
    return {
      nodeType: 3,
      nodeValue: text,
      parentElement: parent,
      rects: [{ left: 10, top: y, right: 110, bottom: y + 20, width: 100, height: 20 }]
    };
  }
  const body = new FakeElement('body');
  body.innerText = 'Legacy body text without layout rects';
  const visibleParent = new FakeElement('article', { 'data-testid': 'visible' });
  visibleParent.parentElement = body;
  const hiddenParent = new FakeElement('div', {}, { display: 'none' });
  hiddenParent.parentElement = body;
  const textNodes = Array.from({ length: count }, (_, index) => makeText(`Item ${index + 1}`, 20 + index * 30, visibleParent));
  textNodes.push(makeText('Hidden Item Must Not Appear', 10, hiddenParent));
  textNodes.push({ nodeType: 3, nodeValue: 'Zero Rect Must Not Appear', parentElement: visibleParent, rects: [{ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }] });

  const document = {
    title: 'Text Fixture',
    body,
    documentElement: { scrollWidth: 1000, scrollHeight: 5000, innerText: body.innerText },
    scrollingElement: { scrollWidth: 1000, scrollHeight: 5000 },
    querySelectorAll() { return []; },
    createTreeWalker() {
      let index = -1;
      return {
        currentNode: null,
        nextNode() {
          index += 1;
          if (index >= textNodes.length) return false;
          this.currentNode = textNodes[index];
          return true;
        }
      };
    },
    createRange() {
      let selected = null;
      return {
        selectNodeContents(node) { selected = node; },
        getClientRects() { return selected?.rects || []; },
        detach() {}
      };
    }
  };

  return {
    document,
    window: {
      innerWidth: 800,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      pageXOffset: 0,
      pageYOffset: 0,
      location: { href: 'https://example.test/text' },
      getComputedStyle: element => element.style || { display: 'block', visibility: 'visible', opacity: '1' }
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CSS: { escape: value => String(value) },
    Array,
    String,
    Number,
    Math,
    Set
  };
}

test('getTextSnapshot keeps full text independent from maxTextRuns metadata cap', async () => {
  const sandbox = createTextSandbox({ count: 5 });
  vm.createContext(sandbox);
  const getTextSnapshot = vm.runInContext(`(${extractFunction(serviceWorker, 'getTextSnapshot')})`, sandbox);
  const result = await getTextSnapshot({ scope: 'full', maxChars: 100000, maxTextRuns: 3, includeRuns: true });
  assert.match(result.text, /Item 5/);
  assert.doesNotMatch(result.text, /Hidden Item Must Not Appear/);
  assert.doesNotMatch(result.text, /Zero Rect Must Not Appear/);
  assert.equal(result.textRuns.length, 3);
  assert.equal(result.runs, result.textRuns);
  assert.equal(result.truncated, false);
  assert.equal(result.caps.textRunsTruncated, true);
  assert.equal(result.caps.totalTextRunCount, 5);
});

test('getDocumentTextSnapshot preserves legacy body.innerText semantics', async () => {
  const sandbox = createTextSandbox({ count: 0 });
  vm.createContext(sandbox);
  const getDocumentTextSnapshot = vm.runInContext(`(${extractFunction(serviceWorker, 'getDocumentTextSnapshot')})`, sandbox);
  const result = await getDocumentTextSnapshot({ maxChars: 1000, includeRuns: true });
  assert.equal(result.text, 'Legacy body text without layout rects');
  assert.equal(Array.isArray(result.textRuns), true);
  assert.equal(result.textRuns.length, 0);
  assert.equal(result.runs, result.textRuns);
  assert.equal(result.caps.extraction, 'body.innerText');
});

function createScrollSandbox() {
  const region = {
    nodeType: 1,
    tagName: 'SECTION',
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 600,
    scrollHeight: 1200,
    clientWidth: 300,
    clientHeight: 300,
    parentElement: null,
    style: { overflow: 'auto', overflowX: 'auto', overflowY: 'auto' },
    scrollBy({ left = 0, top = 0 }) {
      this.scrollLeft = Math.max(0, Math.min(this.scrollLeft + left, this.scrollWidth - this.clientWidth));
      this.scrollTop = Math.max(0, Math.min(this.scrollTop + top, this.scrollHeight - this.clientHeight));
    },
    scrollTo({ left = this.scrollLeft, top = this.scrollTop }) {
      this.scrollLeft = Math.max(0, Math.min(left, this.scrollWidth - this.clientWidth));
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    }
  };
  const card = {
    nodeType: 1,
    tagName: 'ARTICLE',
    parentElement: region,
    scrollIntoViewCalled: false,
    _rectY: 400,
    getBoundingClientRect() { return { x: 20, y: this._rectY, width: 80, height: 40 }; },
    scrollIntoView() { this.scrollIntoViewCalled = true; this._rectY = 200; }
  };
  region.parentElement = { nodeType: 1, tagName: 'BODY', parentElement: null };
  const document = {
    body: region.parentElement,
    documentElement: { scrollWidth: 800, scrollHeight: 2000, clientWidth: 800, clientHeight: 600 },
    scrollingElement: { scrollWidth: 800, scrollHeight: 2000 },
    querySelector(selector) { return selector === '#card' ? card : selector === '#region' ? region : null; }
  };
  const windowObj = {
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: element => element.style || { overflow: 'visible', overflowX: 'visible', overflowY: 'visible' },
    scrollBy({ left = 0, top = 0 }) { this.scrollX += left; this.scrollY += top; },
    scrollTo({ left = this.scrollX, top = this.scrollY }) { this.scrollX = left; this.scrollY = top; }
  };
  return { document, window: windowObj, region, card, Element: Object, setTimeout, Math, Number };
}

test('performDomScroll defaults selector plus delta to nearest scroll container', async () => {
  const sandbox = createScrollSandbox();
  vm.createContext(sandbox);
  const block = extractFunctionBlock(serviceWorker, 'numeric', 'performDomScroll');
  const performDomScroll = vm.runInContext(`${block}; performDomScroll`, sandbox);
  const result = await performDomScroll({ selector: '#card', deltaY: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.target, 'element');
  assert.equal(result.before.scrollY, 0);
  assert.equal(result.after.scrollY, 200);
  assert.equal(result.movedY, 200);
  assert.equal(sandbox.card.scrollIntoViewCalled, false);
});

test('performDomScroll keeps selector-only default as scrollIntoView', async () => {
  const sandbox = createScrollSandbox();
  vm.createContext(sandbox);
  const block = extractFunctionBlock(serviceWorker, 'numeric', 'performDomScroll');
  const performDomScroll = vm.runInContext(`${block}; performDomScroll`, sandbox);
  const result = await performDomScroll({ selector: '#card' });
  assert.equal(result.ok, true);
  assert.equal(sandbox.card.scrollIntoViewCalled, true);
});
