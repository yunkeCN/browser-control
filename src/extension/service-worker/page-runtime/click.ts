type ClickElement = any;

export function performClick(selector: string, options: any = {}): any {
  function localFindElement(sel: string | null | undefined): ClickElement | null {
    if (!sel) return null;
    try {
        if (String(sel).startsWith('@e')) return document.querySelector(`[data-agent-id="${sel}"]`) as ClickElement | null;
        return document.querySelector(sel) as ClickElement | null;
    } catch {
      return null;
    }
  }

  function localDescribeElement(el: Element | null): any {
    if (!el || !el.tagName) return null;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      className: typeof el.className === 'string' ? el.className || null : null,
      role: el.getAttribute?.('role') || null,
      text: (el.textContent || '').trim().slice(0, 100),
      rect: rect ? { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) } : null
    };
  }

  function localMouseButton(button: unknown): number {
    if (button === 'middle') return 1;
    if (button === 'right') return 2;
    return 0;
  }

  function localModifiers(modifiers: unknown): MouseEventInit {
    const list = Array.isArray(modifiers) ? modifiers.map(String) : [];
    return {
      altKey: list.some(m => /^alt$/i.test(m)),
      ctrlKey: list.some(m => /^(ctrl|control)$/i.test(m)),
      metaKey: list.some(m => /^(meta|cmd|command)$/i.test(m)),
      shiftKey: list.some(m => /^shift$/i.test(m))
    };
  }

  function localElementClick() {
    const el = localFindElement(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    if (typeof el.click !== 'function') return { error: `Element cannot be clicked directly: ${selector}` };
    const focusBefore = localDescribeElement(document.activeElement);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.click();
    return {
      clicked: true,
      selector,
      strategyUsed: 'element_click',
      synthetic: true,
      target: localDescribeElement(el),
      focusBefore,
      focusAfter: localDescribeElement(document.activeElement),
      warnings: ['element_click calls el.click() directly and may bypass pointer/mouse semantics and overlay hit-testing.']
    };
  }

  function localDomPointerClick() {
    const el = localFindElement(selector);
    if (!el) return { error: `Element not found: ${selector}` };
    const warnings = [...(Array.isArray(options?.warnings) ? options.warnings : [])];
    const focusBefore = localDescribeElement(document.activeElement);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { error: `Element is not clickable because it has no visible box: ${selector}` };
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint?.(clientX, clientY) || el;
    const hitWithinTarget = hit === el || Boolean(el.contains?.(hit));
    const hitTest = { clientX, clientY, hitWithinTarget, hit: localDescribeElement(hit), coveredBy: hitWithinTarget ? null : localDescribeElement(hit) };
    if (!hitWithinTarget && options?.force !== true) {
      return {
        error: `Element is covered at click point: ${selector}`,
        code: 'COVERED_TARGET',
        recoverable: true,
        selector,
        strategyUsed: options?.strategyUsed || 'dom_pointer',
        target: localDescribeElement(el),
        hitTest,
        warnings: ['Target center is covered. Use a fresh snapshot, close the overlay, choose a visible child target, or retry with force:true only after confirming intent.']
      };
    }
    if (!hitWithinTarget) warnings.push('force:true bypassed covered-element hit-test; dispatched events to the requested element.');
    const dispatchTarget = hitWithinTarget ? hit : el;
    const button = localMouseButton(options?.button);
    const clickCount = Math.max(1, Number(options?.clickCount || 1));
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
      ...localModifiers(options?.modifiers)
    };
    const pointerBase = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 };
    const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    for (const [type, Ctor, init] of [
      ['pointerover', PointerCtor, pointerBase],
      ['pointerenter', PointerCtor, { ...pointerBase, bubbles: false }],
      ['mouseover', MouseEvent, base],
      ['mouseenter', MouseEvent, { ...base, bubbles: false }],
      ['pointermove', PointerCtor, pointerBase],
      ['mousemove', MouseEvent, base],
      ['pointerdown', PointerCtor, pointerBase],
      ['mousedown', MouseEvent, base],
      ['pointerup', PointerCtor, { ...pointerBase, buttons: 0, pressure: 0 }],
      ['mouseup', MouseEvent, { ...base, buttons: 0 }],
      ['click', MouseEvent, { ...base, buttons: 0 }]
    ] as Array<[string, typeof MouseEvent, MouseEventInit]>) {
      if (type === 'pointerup' && typeof el.focus === 'function') el.focus({ preventScroll: true });
      dispatchTarget.dispatchEvent(new (Ctor as typeof MouseEvent)(type, init as MouseEventInit));
    }
    return {
      clicked: true,
      selector,
      strategyUsed: options?.strategyUsed || 'dom_pointer',
      synthetic: true,
      target: localDescribeElement(el),
      dispatchedTo: localDescribeElement(dispatchTarget),
      hitTest,
      focusBefore,
      focusAfter: localDescribeElement(document.activeElement),
      warnings
    };
  }

  const strategy = options?.strategy || 'dom_pointer';
  if (strategy === 'auto' || strategy === 'dom_pointer') {
    return localDomPointerClick();
  }
  if (strategy === 'element_click') {
    return localElementClick();
  }
  return { error: `Unsupported click strategy in page context: ${strategy}` };
}
