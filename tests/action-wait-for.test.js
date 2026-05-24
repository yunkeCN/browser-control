'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const serviceWorkerSource = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'extension', 'service-worker.js'), 'utf8');

test('wait_for text succeeds only for visible text in the page runtime', async () => {
  const visible = createElement('div', {
    id: 'message',
    text: 'Saved   successfully',
    rect: visibleRect()
  });
  const hidden = createElement('div', {
    id: 'hidden',
    text: 'Hidden Ready',
    rect: visibleRect(),
    style: { display: 'none' }
  });
  const ariaHidden = createElement('div', {
    id: 'aria-hidden',
    text: 'Aria Hidden Ready',
    rect: visibleRect(),
    attributes: { 'aria-hidden': 'true' }
  });
  const document = createFakeDocument([visible, hidden, ariaHidden]);
  const waitFor = loadPerformWaitFor(document);

  const result = await waitFor({ text: 'Saved successfully', timeoutMs: 0 });
  assert.equal(result.waited, true);
  assert.equal(result.text, 'Saved successfully');

  const hiddenResult = await waitFor({ text: 'Hidden Ready', timeoutMs: 0 });
  assert.match(hiddenResult.error, /Timed out waiting for text: "Hidden Ready"/);

  const ariaHiddenResult = await waitFor({ text: 'Aria Hidden Ready', timeoutMs: 0 });
  assert.match(ariaHiddenResult.error, /Timed out waiting for text: "Aria Hidden Ready"/);
});

test('wait_for text includes visible control labels and values but excludes password values', async () => {
  const input = createElement('input', {
    id: 'search',
    rect: visibleRect(),
    attributes: { placeholder: 'Search projects' }
  });
  const textarea = createElement('textarea', {
    id: 'notes',
    rect: visibleRect(),
    value: 'Release notes ready'
  });
  const password = createElement('input', {
    id: 'secret',
    rect: visibleRect(),
    value: 'Never Match Me',
    attributes: { type: 'password' }
  });
  const document = createFakeDocument([input, textarea, password]);
  const waitFor = loadPerformWaitFor(document);

  assert.equal((await waitFor({ text: 'Search projects', timeoutMs: 0 })).waited, true);
  assert.equal((await waitFor({ text: 'Release notes ready', timeoutMs: 0 })).waited, true);
  assert.match((await waitFor({ text: 'Never Match Me', timeoutMs: 0 })).error, /Timed out waiting for text/);
});

test('wait_for keeps selector and expression behavior unchanged', async () => {
  const done = createElement('div', { id: 'done', text: 'Done', rect: visibleRect() });
  const document = createFakeDocument([done]);
  const waitFor = loadPerformWaitFor(document);

  assert.equal((await waitFor({ selector: '#done', timeoutMs: 0 })).waited, true);
  assert.equal((await waitFor({ expression: '1 + 1 === 2', timeoutMs: 0 })).waited, true);
});

test('wait_for docs and protocol expose text semantics', () => {
  const api = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'api.md'), 'utf8');
  const recipes = fs.readFileSync(path.join(root, 'skills', 'browser-control', 'references', 'recipes.md'), 'utf8');
  const contracts = fs.readFileSync(path.join(root, 'contracts.ts'), 'utf8');

  assert.match(contracts, /wait_for:\s*\{[^}]*text\?:\s*string/s);
  assert.match(contracts, /wait_for:\s*\{[^}]*state\?:\s*'visible' \| 'attached' \| 'hidden' \| 'detached'/s);
  assert.match(contracts, /wait_for:\s*\{[^}]*expression\?:\s*string/s);
  assert.match(api, /visible text/i);
  assert.match(api, /whitespace/i);
  assert.match(api, /state.*visible.*attached.*hidden.*detached/is);
  assert.match(api, /expression.*JavaScript expression/is);
  assert.match(recipes, /\{"text":"Success","timeoutMs":10000\}/);
});

test('service-worker wait_for handler passes text into page wait runtime', () => {
  assert.match(serviceWorkerSource, /const \{ selector, text, state = ['"]visible['"], timeoutMs = (5000|5e3), expression \} = args \|\| \{\};/);
  assert.match(serviceWorkerSource, /args: \[\{ selector, text, state, timeoutMs, expression \}\]/);
  assert.match(serviceWorkerSource, /Wait script returned no result/);
});

function loadPerformWaitFor(document) {
  const fnSource = extractFunction(serviceWorkerSource, 'performWaitFor');
  const sandbox = createVmContext(document);
  vm.createContext(sandbox);
  return vm.runInContext(`(${fnSource})`, sandbox);
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
  return {
    document,
    window: {
      innerWidth: 1024,
      innerHeight: 768,
      getComputedStyle: el => ({
        display: el.style.display ?? 'block',
        visibility: el.style.visibility ?? 'visible',
        opacity: el.style.opacity ?? '1'
      })
    },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    setTimeout
  };
}

function createFakeDocument(elements) {
  const body = createElement('body', { id: 'body', rect: visibleRect() });
  for (const element of elements) body.appendChild(element);
  const allElements = [body, ...collectElements(body)];

  return {
    body,
    documentElement: body,
    querySelector(selector) {
      if (!selector) return null;
      if (selector.startsWith('#')) return allElements.find(el => el.id === selector.slice(1)) || null;
      if (selector.startsWith('[data-agent-id="')) {
        const id = selector.slice('[data-agent-id="'.length, -2);
        return allElements.find(el => el.getAttribute('data-agent-id') === id) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector !== 'input, textarea, select, img, [aria-label], [placeholder]') return [];
      return allElements.filter(el => {
        const tag = el.tagName.toLowerCase();
        return ['input', 'textarea', 'select', 'img'].includes(tag) ||
          Boolean(el.getAttribute('aria-label')) ||
          Boolean(el.getAttribute('placeholder'));
      });
    },
    createTreeWalker(root, _whatToShow, filter) {
      const textNodes = collectTextNodes(root).filter(node => filter.acceptNode(node) === 1);
      let index = -1;
      return {
        currentNode: null,
        nextNode() {
          index += 1;
          this.currentNode = textNodes[index] || null;
          return Boolean(this.currentNode);
        }
      };
    },
    createRange() {
      let node = null;
      return {
        selectNodeContents(nextNode) {
          node = nextNode;
        },
        getClientRects() {
          return node?.rects || [];
        },
        detach() {}
      };
    }
  };
}

function createElement(tagName, options = {}) {
  const element = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id: options.id || '',
    style: options.style || {},
    rect: options.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    attributes: options.attributes || {},
    value: options.value || '',
    children: [],
    parentElement: null,
    selectedOptions: options.selectedText ? [{ text: options.selectedText }] : [],
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    getAttribute(name) {
      if (name === 'id') return this.id || null;
      return this.attributes[name] ?? null;
    },
    hasAttribute(name) {
      return this.attributes[name] !== undefined;
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesClosestSelector(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    getBoundingClientRect() {
      return this.rect;
    }
  };
  if (options.text) {
    element.appendChild({
      nodeType: 3,
      nodeValue: options.text,
      parentElement: element,
      rects: [options.textRect || element.rect]
    });
  }
  return element;
}

function matchesClosestSelector(el, selector) {
  const tag = el.tagName.toLowerCase();
  if (selector.includes('[aria-hidden="true"]') && el.getAttribute('aria-hidden') === 'true') return true;
  if (selector.includes('[hidden]') && el.hasAttribute('hidden')) return true;
  if (selector.includes('template') && tag === 'template') return true;
  if (selector.includes('script') && tag === 'script') return true;
  if (selector.includes('style') && tag === 'style') return true;
  if (selector.includes('noscript') && tag === 'noscript') return true;
  return false;
}

function collectElements(root) {
  const out = [];
  for (const child of root.children || []) {
    if (child.nodeType === 1) {
      out.push(child);
      out.push(...collectElements(child));
    }
  }
  return out;
}

function collectTextNodes(root) {
  const out = [];
  for (const child of root.children || []) {
    if (child.nodeType === 3) out.push(child);
    if (child.nodeType === 1) out.push(...collectTextNodes(child));
  }
  return out;
}

function visibleRect() {
  return { left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 };
}
