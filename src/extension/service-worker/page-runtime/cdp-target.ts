type CdpTargetElement = any;

export function resolveClickTargetForCdp(selector: string, options: any = {}): any {
  function localFindElement(sel: string | null | undefined): { element: CdpTargetElement | null; error?: any } | null {
    if (!sel) return null;
    try {
        if (String(sel).startsWith('@e')) {
          const runtime = (window as any).__browserControlAgentRef;
          if (!runtime?.resolve) {
            return { element: null, error: { error: `Agent reference runtime is unavailable for ${sel}. Take a fresh snapshot.`, code: 'STALE_ELEMENT_REFERENCE', recoverable: true, retryable: true, selector: sel, strategyUsed: 'cdp_mouse', nextStep: 'Take a fresh snapshot and retry with the new @e reference.' } };
          }
          const resolved = runtime.resolve(String(sel));
          if (resolved?.error) return { element: null, error: { ...resolved, strategyUsed: 'cdp_mouse' } };
          return { element: resolved.element as CdpTargetElement };
        }
        return { element: document.querySelector(sel) as CdpTargetElement | null };
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
      rect: rect ? {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      } : null
    };
  }

  const found = localFindElement(selector);
  if (found?.error) return found.error;
  const el = found?.element;
  if (!el) return { error: `Element not found: ${selector}`, recoverable: true, strategyUsed: 'cdp_mouse' };

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { error: `Element is not clickable because it has no visible box: ${selector}`, recoverable: true, strategyUsed: 'cdp_mouse' };
  }

  const clientX = Math.round(rect.left + rect.width / 2);
  const clientY = Math.round(rect.top + rect.height / 2);
  const hit = document.elementFromPoint?.(clientX, clientY) || el;
  const hitWithinTarget = hit === el || Boolean(el.contains?.(hit));
  const hitTest = {
    clientX,
    clientY,
    hitWithinTarget,
    hit: localDescribeElement(hit),
    coveredBy: hitWithinTarget ? null : localDescribeElement(hit)
  };
  if (!hitWithinTarget && options?.force !== true) {
    return {
      error: `Element is covered at click point: ${selector}`,
      code: 'COVERED_TARGET',
      recoverable: true,
      selector,
      strategyUsed: 'cdp_mouse',
      target: localDescribeElement(el),
      hitTest,
      warnings: ['Target center is covered. Use force:true only after confirming the overlay should be bypassed.']
    };
  }

  return {
    selector,
    strategyUsed: 'cdp_mouse',
    target: localDescribeElement(el),
    hitTest,
    warnings: hitWithinTarget ? [] : ['force:true bypassed covered-element hit-test for cdp_mouse.']
  };
}
