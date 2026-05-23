export function performWaitFor(options: any): Promise<any> {
  const { selector, text, state = 'visible', timeoutMs = 5000, expression } = options || {};
  const textNeedle = normalizeText(text);
  const hasText = text !== undefined && text !== null && textNeedle !== '';
  function localFindElement(sel: string | null | undefined): { element: Element | null; error?: any } | null {
    if (!sel) return null;
    try {
      if (String(sel).startsWith('@e')) {
        const runtime = (window as any).__browserControlAgentRef;
        if (!runtime?.resolve) return { element: null, error: { error: `Agent reference runtime is unavailable for ${sel}. Take a fresh snapshot.`, code: 'STALE_ELEMENT_REFERENCE', recoverable: true, retryable: true, selector: sel, nextStep: 'Take a fresh snapshot and retry with the new @e reference.' } };
        const resolved = runtime.resolve(String(sel));
        if (resolved?.error) return { element: null, error: resolved };
        return { element: resolved.element as Element };
      }
      return { element: document.querySelector(sel) };
    } catch {
      return null;
    }
  }
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
    const next = normalizeText(`${accumulator} ${normalized}`).slice(-120000);
    return next;
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
    if (expression) {
      return Boolean(new Function(`return (${expression});`)());
    }
    if (hasText) return pageHasVisibleText(textNeedle);
    const found = selector ? localFindElement(selector) : null;
    if (found?.error) throw found.error;
    const el = found?.element || null;
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
        return resolve(err?.code ? err : { error: err.message });
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
