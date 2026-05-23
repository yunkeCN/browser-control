type FillElement = any;

export function performFill(selector: string, value: any, options: any = {}): any {
  function localFindElement(sel: string | null | undefined): { element: FillElement | null; error?: any } | null {
    if (!sel) return null;
    try {
      if (String(sel).startsWith('@e')) {
        const runtime = (window as any).__browserControlAgentRef;
        if (!runtime?.resolve) {
          return { element: null, error: { error: `Agent reference runtime is unavailable for ${sel}. Take a fresh snapshot.`, code: 'STALE_ELEMENT_REFERENCE', recoverable: true, retryable: true, selector: sel, nextStep: 'Take a fresh snapshot and retry with the new @e reference.' } };
        }
        const resolved = runtime.resolve(String(sel));
        if (resolved?.error) return { element: null, error: resolved };
        return { element: resolved.element as FillElement };
      }
      return { element: document.querySelector(sel) as FillElement | null };
    } catch {
      return null;
    }
  }
  function localDescribeElement(el: Element | null): any {
    if (!el || !el.tagName) return null;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute?.('name') || null,
      type: el.getAttribute?.('type') || null
    };
  }
  function isSensitiveElement(el: FillElement): boolean {
    const haystack = [el.getAttribute?.('type'), el.getAttribute?.('name'), el.id, el.getAttribute?.('autocomplete'), el.getAttribute?.('aria-label'), el.getAttribute?.('placeholder')]
      .filter(Boolean).join(' ').toLowerCase();
    return /\b(password|passwd|token|secret|api[-_ ]?key|access[-_ ]?key|credential)\b/.test(haystack);
  }
  function valueSummary(el: FillElement, rawValue: unknown): any {
    return {
      length: String(rawValue ?? '').length,
      redacted: isSensitiveElement(el) ? true : undefined,
      value: isSensitiveElement(el) ? undefined : String(rawValue ?? '').slice(0, 100)
    };
  }
  function dispatchInput(el: FillElement, inputType: string, data: string | null): void {
    const InputCtor = typeof InputEvent === 'function' ? InputEvent : Event;
    try {
      el.dispatchEvent(new InputCtor('beforeinput', { bubbles: true, cancelable: true, inputType, data }));
      el.dispatchEvent(new InputCtor('input', { bubbles: true, cancelable: true, inputType, data }));
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }
  }
  function commitFill(el: FillElement, commit: string): void {
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

  const found = localFindElement(selector);
  if (found?.error) return found.error;
  const el = found?.element;
  if (!el) return { error: `Element not found: ${selector}` };

  const tag = el.tagName.toLowerCase();
  const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true';
  const clear = options?.clear !== false;
  const commit = options?.commit || 'change';
  const focusBefore = localDescribeElement(document.activeElement);
  const beforeLength = String(el.value ?? el.textContent ?? '').length;
  const warnings: string[] = [];

  // Scroll into view and focus
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  el.focus();

  if (isContentEditable) {
    // For rich text editors (ProseMirror, TipTap, Lexical, etc.)
    const selection = window.getSelection?.();
    if (selection && document.createRange) {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!clear) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } else if (clear) {
      el.select?.();
    }
    // Clear existing content then insert
    if (document.execCommand) {
      if (clear) document.execCommand('selectAll', false, null as any);
      document.execCommand('insertText', false, value);
    } else {
      el.textContent = clear ? value : `${el.textContent || ''}${value}`;
    }
    dispatchInput(el, 'insertText', isSensitiveElement(el) ? null : String(value));
    commitFill(el, commit);
    return { filled: true, mode: 'contenteditable', strategyUsed: options?.strategy || 'native_setter', selector, target: localDescribeElement(el), clear, commit, focusBefore, focusAfter: localDescribeElement(document.activeElement), before: { length: beforeLength }, after: valueSummary(el, el.textContent || ''), warnings: warnings.length ? warnings : undefined };
  }

  if (tag === 'input' || tag === 'textarea') {
    // Use the element's own native setter to trigger React/Vue bindings.
    // Input and textarea value setters are not interchangeable in all browsers.
    const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    const nextValue = clear ? value : `${el.value || ''}${value}`;
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
        target: localDescribeElement(el),
        strategyUsed: options?.strategy || 'native_setter',
        clear,
        commit,
        focusBefore,
        focusAfter: localDescribeElement(document.activeElement),
        before: { length: beforeLength },
        after: valueSummary(el, el.value),
        warnings: warnings.length ? warnings : undefined
      };
    }

    dispatchInput(el, 'insertText', isSensitiveElement(el) ? null : String(value));
    commitFill(el, commit);
    return { filled: true, mode: 'value', strategyUsed: options?.strategy || 'native_setter', selector, target: localDescribeElement(el), clear, commit, focusBefore, focusAfter: localDescribeElement(document.activeElement), before: { length: beforeLength }, after: valueSummary(el, el.value), warnings: warnings.length ? warnings : undefined };
  }

  // For select elements
  if (tag === 'select') {
    el.value = value;
    commitFill(el, commit);
    return { filled: true, mode: 'select', strategyUsed: options?.strategy || 'native_setter', selector, target: localDescribeElement(el), clear, commit, focusBefore, focusAfter: localDescribeElement(document.activeElement), before: { length: beforeLength }, after: valueSummary(el, el.value), warnings: warnings.length ? warnings : undefined };
  }

  // Fallback for other elements
  if (el.value !== undefined) {
    if (clear) el.value = '';
    el.value = clear ? value : `${el.value || ''}${value}`;
    dispatchInput(el, 'insertText', isSensitiveElement(el) ? null : String(value));
    commitFill(el, commit);
    return { filled: true, mode: 'value', strategyUsed: options?.strategy || 'native_setter', selector, target: localDescribeElement(el), clear, commit, focusBefore, focusAfter: localDescribeElement(document.activeElement), before: { length: beforeLength }, after: valueSummary(el, el.value), warnings: warnings.length ? warnings : undefined };
  }

  return { error: `Cannot fill element type: ${tag}` };
}
