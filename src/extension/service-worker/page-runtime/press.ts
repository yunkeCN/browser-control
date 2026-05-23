type PressElement = any;

export function performPress(key: string, selector: string | null, options: any = {}): any {
  function localFindElement(sel: string | null): { element: PressElement | null; error?: any } | null {
    if (!sel) return null;
    try {
      if (String(sel).startsWith('@e')) {
        const runtime = (window as any).__browserControlAgentRef;
        if (!runtime?.resolve) {
          return { element: null, error: { error: `Agent reference runtime is unavailable for ${sel}. Take a fresh snapshot.`, code: 'STALE_ELEMENT_REFERENCE', recoverable: true, retryable: true, selector: sel, nextStep: 'Take a fresh snapshot and retry with the new @e reference.' } };
        }
        const resolved = runtime.resolve(String(sel));
        if (resolved?.error) return { element: null, error: resolved };
        return { element: resolved.element as PressElement };
      }
      return { element: document.querySelector(sel) as PressElement | null };
    } catch {
      return null;
    }
  }
  function localDescribeElement(el: Element | null): any {
    if (!el || !el.tagName) return null;
    return { tag: el.tagName.toLowerCase(), id: el.id || null, role: el.getAttribute?.('role') || null };
  }
  function localModifiers(modifiers: unknown): KeyboardEventInit {
    const list = Array.isArray(modifiers) ? modifiers.map(String) : [];
    return {
      altKey: list.some(m => /^alt$/i.test(m)),
      ctrlKey: list.some(m => /^(ctrl|control)$/i.test(m)),
      metaKey: list.some(m => /^(meta|cmd|command)$/i.test(m)),
      shiftKey: list.some(m => /^shift$/i.test(m))
    };
  }
  const found = selector ? localFindElement(selector) : null;
  if (found?.error) return found.error;
  const target = selector ? found?.element : document.activeElement || document.body;
  if (!target) return { error: selector ? `Element not found: ${selector}` : 'No focused element' };
  const focusBefore = localDescribeElement(document.activeElement);
  target.focus?.();
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const modifiers = localModifiers(options?.modifiers);
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
    target: localDescribeElement(target),
    focusBefore,
    focusAfter: localDescribeElement(document.activeElement),
    warnings: Array.isArray(options?.warnings) ? options.warnings : []
  };
}
