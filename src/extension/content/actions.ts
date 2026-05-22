// ─── Element interaction functions ────────────────────────────────────

type AgentElement = any;
interface EvaluationSerializeState {
  warnings: string[];
  truncated: boolean;
  seen: WeakSet<object> | null;
}

export function findElement(selector: string): AgentElement | null {
  // @e reference
  if (selector.startsWith('@e')) {
    return document.querySelector(`[data-agent-id="${selector}"]`) as AgentElement | null;
  }
  // CSS selector
  try {
    return document.querySelector(selector) as AgentElement | null;
  } catch {
    return null;
  }
}

export function performClick(selector: string, options: any = {}): any {
  const strategy = options?.strategy || 'dom_pointer';
  if (strategy === 'auto' || strategy === 'dom_pointer') {
    return performDomPointerClick(selector, { ...options, strategyUsed: 'dom_pointer' });
  }
  if (strategy === 'element_click') {
    return performElementClick(selector);
  }
  return { error: `Unsupported click strategy in content context: ${strategy}` };
}

export function performDomPointerClick(selector: string, options: any = {}): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };

  const warnings = [...(Array.isArray(options?.warnings) ? options.warnings : [])];
  const focusBefore = describeElement(document.activeElement);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });

  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { error: `Element is not clickable because it has no visible box: ${selector}` };
  }

  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const hit = document.elementFromPoint?.(clientX, clientY) || el;
  const hitWithinTarget = hit === el || Boolean(el.contains?.(hit));
  const force = options?.force === true;
  const hitTest = {
    clientX,
    clientY,
    hitWithinTarget,
    hit: describeElement(hit),
    coveredBy: hitWithinTarget ? null : describeElement(hit)
  };

  if (!hitWithinTarget && !force) {
    return {
      error: `Element is covered at click point: ${selector}`,
      code: 'COVERED_TARGET',
      recoverable: true,
      selector,
      strategyUsed: options?.strategyUsed || 'dom_pointer',
      target: describeElement(el),
      hitTest,
      warnings: ['Target center is covered. Use a fresh snapshot, close the overlay, choose a visible child target, or retry with force:true only after confirming intent.']
    };
  }
  if (!hitWithinTarget && force) {
    warnings.push('force:true bypassed covered-element hit-test; dispatched events to the requested element.');
  }

  const dispatchTarget = hitWithinTarget ? hit : el;
  const button = normalizeMouseButton(options?.button);
  const clickCount = Math.max(1, Number(options?.clickCount || 1));
  const modifierState = normalizeModifiers(options?.modifiers);
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: Math.round((window.screenX || 0) + clientX),
    screenY: Math.round((window.screenY || 0) + clientY),
    button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 1,
    detail: clickCount,
    ...modifierState
  };
  const pointerBase = {
    ...base,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    width: 1,
    height: 1,
    pressure: 0.5
  };
  const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

  for (const [type, Ctor, init] of [
    ['pointerover', PointerCtor, pointerBase],
    ['pointerenter', PointerCtor, { ...pointerBase, bubbles: false }],
    ['mouseover', MouseEvent, base],
    ['mouseenter', MouseEvent, { ...base, bubbles: false }],
    ['pointermove', PointerCtor, pointerBase],
    ['mousemove', MouseEvent, base],
    ['pointerdown', PointerCtor, pointerBase],
    ['mousedown', MouseEvent, base]
  ] as Array<[string, typeof MouseEvent, MouseEventInit]>) {
    dispatchTarget.dispatchEvent(new (Ctor as typeof MouseEvent)(type, init as MouseEventInit));
  }

  if (typeof el.focus === 'function') {
    el.focus({ preventScroll: true });
  }

  for (const [type, Ctor, init] of [
    ['pointerup', PointerCtor, { ...pointerBase, buttons: 0, pressure: 0 }],
    ['mouseup', MouseEvent, { ...base, buttons: 0 }],
    ['click', MouseEvent, { ...base, buttons: 0 }]
  ] as Array<[string, typeof MouseEvent, MouseEventInit]>) {
    dispatchTarget.dispatchEvent(new (Ctor as typeof MouseEvent)(type, init as MouseEventInit));
  }

  return {
    clicked: true,
    selector,
    strategyUsed: options?.strategyUsed || 'dom_pointer',
    synthetic: true,
    target: describeElement(el),
    dispatchedTo: describeElement(dispatchTarget),
    hitTest,
    focusBefore,
    focusAfter: describeElement(document.activeElement),
    warnings
  };
}

export function performElementClick(selector: string): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  if (typeof el.click !== 'function') return { error: `Element cannot be clicked directly: ${selector}` };
  const focusBefore = describeElement(document.activeElement);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.click();
  return {
    clicked: true,
    selector,
    strategyUsed: 'element_click',
    synthetic: true,
    target: describeElement(el),
    focusBefore,
    focusAfter: describeElement(document.activeElement),
    warnings: ['element_click calls el.click() directly and may bypass pointer/mouse semantics and overlay hit-testing.']
  };
}

export function normalizeMouseButton(button: unknown): number {
  if (button === 'middle') return 1;
  if (button === 'right') return 2;
  return 0;
}

export function normalizeModifiers(modifiers: unknown): MouseEventInit {
  const list = Array.isArray(modifiers) ? modifiers.map(String) : [];
  return {
    altKey: list.some(m => /^alt$/i.test(m)),
    ctrlKey: list.some(m => /^(ctrl|control)$/i.test(m)),
    metaKey: list.some(m => /^(meta|cmd|command)$/i.test(m)),
    shiftKey: list.some(m => /^shift$/i.test(m))
  };
}

export function describeElement(el: Element | null): any {
  if (!el || !el.tagName) return null;
  const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === 'string' ? el.className || null : null,
    role: el.getAttribute?.('role') || null,
    text: (el.textContent || '').trim().slice(0, 100),
    rect: rect ? {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    } : null
  };
}

export function performFill(selector: string, value: any, options: any = {}): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const focusBefore = describeElement(document.activeElement);
  el.focus();

  const tag = el.tagName.toLowerCase();
  const isContentEditable = el.isContentEditable ||
    el.getAttribute('contenteditable') === 'true';
  const clear = options?.clear !== false;
  const commit = options?.commit || 'change';
  const beforeLength = String(el.value ?? el.textContent ?? '').length;
  const sensitive = isSensitiveFillElement(el);
  const warnings: string[] = [];

  function summary(rawValue: unknown): any {
    return {
      length: String(rawValue ?? '').length,
      redacted: sensitive ? true : undefined,
      value: sensitive ? undefined : String(rawValue ?? '').slice(0, 100)
    };
  }

  function dispatchInput(inputType: string, data: string | null): void {
    const InputCtor = typeof InputEvent === 'function' ? InputEvent : Event;
    try {
      el.dispatchEvent(new InputCtor('beforeinput', { bubbles: true, cancelable: true, inputType, data }));
      el.dispatchEvent(new InputCtor('input', { bubbles: true, cancelable: true, inputType, data }));
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
  }

  function commitValue() {
    if (commit === 'none') return;
    if (commit === 'blur') {
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      el.blur?.();
      return;
    }
    if (commit === 'enter') {
      const init = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return;
    }
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  }

  function result(mode: string, rawValue: unknown): any {
    return {
      filled: true,
      mode,
      strategyUsed: options?.strategy || 'native_setter',
      selector,
      target: describeElement(el),
      clear,
      commit,
      focusBefore,
      focusAfter: describeElement(document.activeElement),
      before: { length: beforeLength },
      after: summary(rawValue),
      warnings: warnings.length ? warnings : undefined
    };
  }

  function setInputLikeValue(nextValue: unknown): any {
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    try {
      if (nativeSetter) {
        if (clear) nativeSetter.call(el, '');
        nativeSetter.call(el, nextValue);
      } else {
        if (clear) el.value = '';
        el.value = nextValue;
        warnings.push('Native value setter was unavailable; used direct assignment.');
      }
    } catch (err: any) {
      if (clear) el.value = '';
      el.value = nextValue;
      warnings.push(`Native value setter failed; used direct assignment (${err?.name || 'Error'}).`);
    }

    if (String(el.value ?? '') !== String(nextValue ?? '')) {
      return {
        error: `Fill verification failed: expected value length ${String(nextValue ?? '').length}, got ${String(el.value ?? '').length}`,
        selector,
        target: describeElement(el),
        strategyUsed: options?.strategy || 'native_setter',
        clear,
        commit,
        before: { length: beforeLength },
        after: summary(el.value),
        warnings: warnings.length ? warnings : undefined
      };
    }
    return null;
  }

  if (isContentEditable) {
    // Rich text editor
    const selection = window.getSelection()!;
    const range = document.createRange();
    if (clear) {
      range.selectNodeContents(el);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(range);

    if (document.execCommand) {
      if (clear) document.execCommand('selectAll', false, null as any);
      document.execCommand('insertText', false, value);
    } else {
      // Modern approach
      const textNode = document.createTextNode(value);
      if (clear) el.textContent = '';
      el.appendChild(textNode);
    }

    dispatchInput('insertText', sensitive ? null : String(value));
    commitValue();
    return result('contenteditable', el.textContent || '');
  }

  if (tag === 'input' || tag === 'textarea') {
    // Use the element's own native setter plus events for framework compatibility.
    // Input and textarea setters are not interchangeable in all browsers.
    const nextValue = clear ? value : `${el.value || ''}${value}`;
    const verificationError = setInputLikeValue(nextValue);
    if (verificationError) return verificationError;

    dispatchInput('insertText', sensitive ? null : String(value));
    commitValue();
    return result('value', el.value);
  }

  if (tag === 'select') {
    el.value = value;
    commitValue();
    return result('select', el.value);
  }

  // Fallback
  if (clear) el.value = '';
  el.value = clear ? value : `${el.value || ''}${value}`;
  dispatchInput('insertText', sensitive ? null : String(value));
  commitValue();
  return result('value', el.value);
}

export function isSensitiveFillElement(el: AgentElement): boolean {
  const haystack = [el.getAttribute?.('type'), el.getAttribute?.('name'), el.id, el.getAttribute?.('autocomplete'), el.getAttribute?.('aria-label'), el.getAttribute?.('placeholder')]
    .filter(Boolean).join(' ').toLowerCase();
  return /\b(password|passwd|token|secret|api[-_ ]?key|access[-_ ]?key|credential)\b/.test(haystack);
}

export function performPress(key: string, selector: string | null, options: any = {}): any {
  if (!key) return { error: 'key is required for press' };
  const target = selector ? findElement(selector) : document.activeElement || document.body;
  if (!target) return { error: selector ? `Element not found: ${selector}` : 'No focused element' };
  const focusBefore = describeElement(document.activeElement);
  target.focus?.();
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const modifiers = normalizeModifiers(options?.modifiers);
  for (const eventType of ['keydown', 'keypress', 'keyup']) {
    target.dispatchEvent(new KeyboardEvent(eventType, {
      key,
      code,
      bubbles: true,
      cancelable: true,
      ...modifiers
    }));
  }
  return {
    pressed: true,
    key,
    code,
    selector: selector || null,
    strategyUsed: options?.strategy || 'dom_keyboard',
    synthetic: true,
    modifiers,
    target: describeElement(target),
    focusBefore,
    focusAfter: describeElement(document.activeElement),
    warnings: Array.isArray(options?.warnings) ? options.warnings : []
  };
}

export function performSelectOption(selector: string, value: unknown): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  if (el.tagName.toLowerCase() !== 'select') return { error: `Element is not a select: ${selector}` };
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  let matched = 0;
  for (const option of el.options) {
    const selected = values.includes(option.value) || values.includes(option.text);
    option.selected = el.multiple ? selected : selected && matched === 0;
    if (selected) matched += 1;
  }
  if (matched === 0) return { error: `No option matched: ${values.join(', ')}` };
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { selected: true, selector, value: Array.from((el as HTMLSelectElement).selectedOptions).map(o => o.value) };
}

export function performSetChecked(selector: string, checked: boolean): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  if (!['checkbox', 'radio'].includes((el.type || '').toLowerCase())) return { error: `Element is not checkable: ${selector}` };
  if (el.checked !== checked) {
    el.click();
    if (el.checked !== checked) el.checked = checked;
  }
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { checked: el.checked, selector };
}

export function performWaitFor(options: any): Promise<any> {
  const { selector, text, state = 'visible', timeoutMs = 5000, expression } = options || {};
  const textNeedle = normalizeText(text);
  const hasText = text !== undefined && text !== null && textNeedle !== '';
  const started = Date.now();
  function normalizeText(value: unknown): string {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }
  function truncateText(value: unknown, max = 80): string {
    const normalized = normalizeText(value);
    return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
  }
  function getAttr(el: Element | null, name: string): string | null {
    return el?.getAttribute?.(name) ?? null;
  }
  function hasAttr(el: Element | null, name: string): boolean {
    return Boolean(el?.hasAttribute?.(name));
  }
  function tagName(el: Element | null): string {
    return String(el?.tagName || '').toLowerCase();
  }
  function intersectsViewport(rect: DOMRect | null): boolean {
    if (!rect) return false;
    const width = rect.width ?? Math.max(0, (rect.right ?? 0) - (rect.left ?? 0));
    const height = rect.height ?? Math.max(0, (rect.bottom ?? 0) - (rect.top ?? 0));
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    return width > 0 && height > 0 &&
      (rect.bottom ?? 0) >= 0 && (rect.right ?? 0) >= 0 &&
      (rect.top ?? 0) <= viewportHeight && (rect.left ?? 0) <= viewportWidth;
  }
  function excludedFromVisibleText(el: Element | null): boolean {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    for (let current: Element | null = el; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
      const tag = tagName(current);
      if (['script', 'style', 'template', 'noscript', 'meta', 'link'].includes(tag)) return true;
      const type = String(getAttr(current, 'type') || '').toLowerCase();
      if (tag === 'input' && (type === 'password' || type === 'hidden')) return true;
      if (getAttr(current, 'aria-hidden') === 'true' || hasAttr(current, 'hidden')) return true;
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
    }
    return false;
  }
  function appendAndMatch(accumulator: string, value: unknown): string {
    const normalized = normalizeText(value);
    if (!normalized) return accumulator;
    return normalizeText(`${accumulator} ${normalized}`).slice(-120000);
  }
  function pageHasVisibleText(needle: string): boolean {
    const root = document.body || document.documentElement;
    if (!root) return false;
    let visibleText = '';
    let scannedNodes = 0;
    const maxScannedNodes = 10000;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const normalized = normalizeText(node.nodeValue);
        if (!normalized) return NodeFilter.FILTER_REJECT;
        if (excludedFromVisibleText(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    while (walker.nextNode()) {
      scannedNodes += 1;
      if (scannedNodes > maxScannedNodes) break;
      const node = walker.currentNode;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(intersectsViewport);
      range.detach?.();
      if (!rects.length) continue;
      visibleText = appendAndMatch(visibleText, node.nodeValue);
      if (visibleText.includes(needle)) return true;
    }

    const controls = Array.from(document.querySelectorAll('input, textarea, select, img, [aria-label], [placeholder]'));
    for (const el of controls) {
      if (excludedFromVisibleText(el)) continue;
      const rect = el.getBoundingClientRect();
      if (!intersectsViewport(rect)) continue;
      const tag = tagName(el);
      let value = '';
      if (tag === 'select') value = (el as HTMLSelectElement).selectedOptions?.[0]?.text || getAttr(el, 'aria-label') || '';
      else if (tag === 'img') value = getAttr(el, 'alt') || getAttr(el, 'aria-label') || '';
      else value = (el as HTMLInputElement | HTMLTextAreaElement).value || getAttr(el, 'placeholder') || getAttr(el, 'aria-label') || '';
      visibleText = appendAndMatch(visibleText, value);
      if (visibleText.includes(needle)) return true;
    }
    return false;
  }
  function visible(el: Element | null): boolean {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }
  function condition(): boolean {
    if (expression) return Boolean(new Function(`return (${expression});`)());
    if (hasText) return pageHasVisibleText(textNeedle);
    const el = selector ? findElement(selector) : null;
    if (state === 'attached') return Boolean(el);
    if (state === 'hidden' || state === 'detached') return !visible(el);
    return visible(el);
  }
  return new Promise<any>((resolve) => {
    const tick = () => {
      try {
        if (condition()) {
          const result: any = { waited: true, selector: selector || null, state, durationMs: Date.now() - started };
          if (hasText) result.text = truncateText(text);
          return resolve(result);
        }
      } catch (err: any) {
        return resolve({ error: err.message });
      }
      if (Date.now() - started >= timeoutMs) {
        const target = hasText ? `text: "${truncateText(text)}"` : selector || expression || state;
        return resolve({ error: `Timed out waiting for ${target}` });
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function performUpload(selector: string, files: unknown): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  if (el.tagName.toLowerCase() !== 'input' || el.type !== 'file') return { error: 'Element is not a file input' };
  return {
    status: 'needs_native_picker',
    selector,
    accept: el.accept || null,
    multiple: el.multiple || false,
    files
  };
}

export function performEvaluate(code: unknown): any {
  const source = String(code ?? '');
  try {
    const result = runEvaluationSource(source);
    return Promise.resolve(result)
      .then(r => serializeEvaluationPayload(r))
      .catch(e => serializeEvaluationError(e));
  } catch (e) {
    return serializeEvaluationError(e);
  }
}

export function runEvaluationSource(source: string): any {
  const hasExplicitReturn = /\breturn\b/.test(source);
  if (!hasExplicitReturn) {
    try {
      return eval(`(async () => (${source}))()`);
    } catch (expressionError) {
      // Fall back to function-body mode for multi-statement snippets.
    }
  }
  return eval(`(async () => { ${source} })()`);
}

export function serializeEvaluationError(error: any): any {
  return {
    error: error?.message || String(error),
    errorDetails: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined
    }
  };
}

export function serializeEvaluationPayload(value: any): any {
  const state: EvaluationSerializeState = { warnings: [], truncated: false, seen: typeof WeakSet !== 'undefined' ? new WeakSet<object>() : null };
  const result = serializeEvaluationValue(value, state, 0);
  const payload: any = { result };
  if (value === undefined) {
    payload.result = null;
    payload.serialization = { undefinedResult: true, warnings: ['Evaluation returned undefined; use `return ...` or a single expression to return data.'] };
    return payload;
  }
  if (state.warnings.length || state.truncated) {
    payload.serialization = { truncated: state.truncated, warnings: state.warnings };
  }
  return payload;
}

export function serializeEvaluationValue(value: any, state: EvaluationSerializeState, depth: number): any {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return value;
  if (type === 'undefined') return null;
  if (type === 'bigint') {
    state.warnings.push('Converted bigint to string.');
    return value.toString();
  }
  if (type === 'symbol' || type === 'function') {
    state.warnings.push(`Converted ${type} to string.`);
    return String(value);
  }
  if (depth >= 6) {
    state.truncated = true;
    return '[MaxDepth]';
  }
  if (state.seen && typeof value === 'object') {
    if (state.seen.has(value)) {
      state.warnings.push('Replaced circular reference.');
      return '[Circular]';
    }
    state.seen.add(value);
  }
  if (typeof Element !== 'undefined' && value instanceof Element) {
    const rect = value.getBoundingClientRect();
    return {
      nodeType: 'element',
      tagName: value.tagName.toLowerCase(),
      id: value.id || null,
      className: typeof value.className === 'string' ? value.className : null,
      textContent: ((value as HTMLElement).innerText || value.textContent || '').slice(0, 500),
      boundingBox: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }
  if (typeof Node !== 'undefined' && value instanceof Node) {
    return { nodeType: value.nodeType, nodeName: value.nodeName, textContent: (value.textContent || '').slice(0, 500) };
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: typeof value.stack === 'string' ? value.stack.split('\n').slice(0, 8).join('\n') : undefined };
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length > 100) state.truncated = true;
    return value.slice(0, 100).map(item => serializeEvaluationValue(item, state, depth + 1));
  }
  const output: any = {};
  const keys = Object.keys(value);
  if (keys.length > 100) state.truncated = true;
  for (const key of keys.slice(0, 100)) {
    try {
      output[key] = serializeEvaluationValue(value[key], state, depth + 1);
    } catch (err: any) {
      output[key] = `[Unserializable: ${err?.message || err}]`;
      state.warnings.push(`Could not serialize property ${key}.`);
    }
  }
  return output;
}

export function scrollToElement(selector: string): any {
  const el = findElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  return { scrolled: true, selector };
}

// ─── Initialization ──────────────────────────────────────────────────

console.log('[AgentBridge] Content script loaded:', window.location.href);
