export function captureViewportTextObservation(options: any = {}) {
  const maxTextChars = Number.isFinite(options.maxTextChars) ? options.maxTextChars : 12000;
  const maxTextRuns = Number.isFinite(options.maxTextRuns) ? options.maxTextRuns : 300;
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
  const textRuns: any[] = [];
  const visibleParts: string[] = [];
  let visibleTextChars = 0;
  let truncated = false;

  const container = options?.selector ? document.querySelector(String(options.selector)) : null;
  if (options?.selector && !container) {
    return {
      error: `selector not found: "${options.selector}"`,
      url: window.location.href, title: document.title, viewport,
      visibleText: '', textRuns: [], truncated: false,
      caps: { maxTextChars, maxTextRuns, selector: options.selector },
      activeElement: null
    };
  }
  const root = (container as Element) || document.body;
  // Always scan the full document for existing @e IDs so scoped extraction does
  // not produce duplicate IDs from a narrower counter starting point.
  let counter = Array.from(document.querySelectorAll('[data-agent-id^="@e"]')).reduce((max, el) => {
    const match = /^@e(\d+)$/.exec(el.getAttribute('data-agent-id') || '');
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  function normalizeText(text: unknown): string {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function isSecretLike(text: unknown): boolean {
    return /(?:bearer|token|secret|password|passwd|api[_-]?key|sk-[a-z0-9_-]{12,})/i.test(String(text || ''));
  }

  function redactText(text: unknown): string {
    const normalized = normalizeText(text);
    if (!normalized) return '';
    return isSecretLike(normalized) ? '[redacted]' : normalized;
  }

  function rectToObject(rect: DOMRect): { x: number; y: number; width: number; height: number } {
    return {
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function intersectsViewport(rect: DOMRect): boolean {
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function visibleElement(el: Element | null): boolean {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'template', 'noscript', 'meta', 'link'].includes(tag)) return false;
    if (el.closest('[aria-hidden="true"],[hidden],template,script,style')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return intersectsViewport(rect) || ['input', 'textarea', 'select', 'option'].includes(tag);
  }

  function ensureAgentId(el: Element | null): string | null {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    let id = el.getAttribute('data-agent-id');
    if (!id) {
      id = `@e${++counter}`;
      try { el.setAttribute('data-agent-id', id); } catch { /* ignore */ }
    }
    return id;
  }

  function cssSelector(el: Element | null): string | null {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    if (typeof el.className === 'string' && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).map((c: string) => CSS.escape(c)).join('.');
      if (cls) return `${tag}.${cls}`;
    }
    return tag;
  }

  function roleFor(el: Element | null): string | null {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      const type = el.getAttribute('type') || 'text';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return null;
  }

  function activeElementInfo(): any {
    const el = document.activeElement as (Element & HTMLInputElement & HTMLTextAreaElement) | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const rect = el.getBoundingClientRect();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const sensitive = type === 'password' || /(?:token|secret|password|passwd|api[_-]?key)/i.test(el.getAttribute('name') || el.getAttribute('aria-label') || '');
    const value = sensitive ? '[redacted]' : ((el as HTMLInputElement | HTMLTextAreaElement).value || el.textContent || '').slice(0, 200);
    return {
      element: ensureAgentId(el),
      tag: el.tagName.toLowerCase(),
      role: roleFor(el),
      selector: cssSelector(el),
      text: redactText(el.getAttribute('aria-label') || el.getAttribute('placeholder') || value),
      valueLength: typeof (el as HTMLInputElement | HTMLTextAreaElement).value === 'string' ? (el as HTMLInputElement | HTMLTextAreaElement).value.length : null,
      rect: rectToObject(rect)
    };
  }

  function addRun(text: unknown, rect: DOMRect, el: Element | null): void {
    if (textRuns.length >= maxTextRuns) {
      truncated = true;
      return;
    }
    const normalizedText = redactText(text);
    if (!normalizedText) return;
    const safeText = normalizedText.slice(0, 500);
    const run = {
      id: `t${textRuns.length + 1}`,
      text: safeText,
      normalizedText: safeText,
      rect: rectToObject(rect),
      element: ensureAgentId(el),
      role: roleFor(el),
      selector: cssSelector(el)
    };
    textRuns.push(run);
    if (visibleTextChars < maxTextChars) {
      const separator = visibleParts.length ? '\n' : '';
      const remaining = maxTextChars - visibleTextChars - separator.length;
      if (remaining > 0) {
        visibleParts.push(separator + safeText.slice(0, remaining));
        visibleTextChars += separator.length + Math.min(safeText.length, remaining);
      }
      if (safeText.length > remaining) truncated = true;
    } else {
      truncated = true;
    }
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = normalizeText(node.nodeValue);
      if (!text) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!visibleElement(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter(intersectsViewport);
    range.detach?.();
    for (const rect of rects) addRun(node.nodeValue, rect, parent);
    if (textRuns.length >= maxTextRuns) {
      truncated = true;
      break;
    }
  }

  const controls = Array.from((container || document).querySelectorAll('input, textarea, select, img, [aria-label], [placeholder]'));
  if (container && container.nodeType === Node.ELEMENT_NODE && (container as Element).matches?.('input, textarea, select, img, [aria-label], [placeholder]')) {
    controls.push(container as Element);
  }
  for (const el of controls) {
    if (textRuns.length >= maxTextRuns) {
      truncated = true;
      break;
    }
    if (!visibleElement(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') continue;
    let text = '';
    if (tag === 'select') text = (el as HTMLSelectElement).selectedOptions?.[0]?.text || el.getAttribute('aria-label') || '';
    else if (tag === 'img') text = el.getAttribute('alt') || el.getAttribute('aria-label') || '';
    else text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el as HTMLInputElement | HTMLTextAreaElement).value || '';
    if (!text) continue;
    const rect = el.getBoundingClientRect();
    if (intersectsViewport(rect)) addRun(text, rect, el);
  }

  return {
    url: window.location.href,
    title: document.title,
    viewport,
    visibleText: visibleParts.join(''),
    textRuns,
    truncated,
    caps: {
      maxTextChars,
      maxTextRuns,
      textRunCount: textRuns.length,
      visibleTextChars
    },
    activeElement: activeElementInfo()
  };
}
