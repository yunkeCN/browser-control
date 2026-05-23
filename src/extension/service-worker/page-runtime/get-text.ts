// ─── get_text runtime extraction (serialized for executeScript) ─────────

export function getTextSnapshot(options: any = {}) {
  const scope = options?.scope === 'viewport' ? 'viewport' : 'full';
  const maxChars = Number.isFinite(options?.maxChars) ? Math.max(0, Math.min(Number(options.maxChars), 200000)) : 12000;
  const maxTextRuns = Number.isFinite(options?.maxTextRuns) ? Math.max(0, Math.min(Number(options.maxTextRuns), 5000)) : 1000;
  const maxArtifactChars = Number.isFinite(options?.maxArtifactChars) ? Math.max(maxChars, Math.min(Number(options.maxArtifactChars), 200000)) : Math.max(maxChars, 200000);
  const includeRuns = options?.includeRuns === true;
  const viewportOnly = scope === 'viewport';
  const entries: any[] = [];
  const runs: any[] = [];
  const seen = new Set<string>();
  let totalTextChars = 0;
  let runLimited = false;

  const blockedTags = new Set(['script', 'style', 'template', 'noscript', 'svg', 'canvas']);
  const controlSelector = 'input, textarea, select, button, img, [aria-label], [role="button"], [role="link"]';
  const scrollingElement = document.scrollingElement || document.documentElement;
  const docBounds = {
    minX: -Math.max(window.innerWidth, 1),
    minY: -Math.max(window.innerHeight, 1),
    maxX: Math.max(scrollingElement?.scrollWidth || 0, document.documentElement.scrollWidth || 0, document.body?.scrollWidth || 0, window.innerWidth),
    maxY: Math.max(scrollingElement?.scrollHeight || 0, document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0, window.innerHeight)
  };

  function normalize(value: string): string {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function rectFromDomRect(rect: DOMRect | ClientRect): any {
    const docX = window.scrollX || window.pageXOffset || 0;
    const docY = window.scrollY || window.pageYOffset || 0;
    return {
      x: Math.round(rect.left + docX),
      y: Math.round(rect.top + docY),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function viewportIntersects(rect: DOMRect | ClientRect): boolean {
    return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function reachableRect(rect: DOMRect | ClientRect): boolean {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (viewportOnly && !viewportIntersects(rect)) return false;
    const x = rect.left + (window.scrollX || window.pageXOffset || 0);
    const y = rect.top + (window.scrollY || window.pageYOffset || 0);
    const right = x + rect.width;
    const bottom = y + rect.height;
    return right >= docBounds.minX && bottom >= docBounds.minY && x <= docBounds.maxX && y <= docBounds.maxY;
  }

  function firstReachableRect(rects: DOMRectList | DOMRect[] | ClientRect[]): DOMRect | ClientRect | null {
    for (const rect of Array.from(rects || []) as Array<DOMRect | ClientRect>) {
      if (reachableRect(rect)) return rect;
    }
    return null;
  }

  function isSensitiveControl(el: any): boolean {
    const type = String(el.getAttribute?.('type') || '').toLowerCase();
    const autocomplete = String(el.getAttribute?.('autocomplete') || '').toLowerCase();
    const name = `${el.getAttribute?.('name') || ''} ${el.getAttribute?.('id') || ''} ${el.getAttribute?.('aria-label') || ''}`.toLowerCase();
    return type === 'password' || autocomplete === 'current-password' || autocomplete === 'one-time-code' || /\b(password|passwd|token|secret|api[-_ ]?key|session|cookie|otp)\b/.test(name);
  }

  function isHiddenElement(el: any): boolean {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName?.toLowerCase?.() || '';
    if (blockedTags.has(tag)) return true;
    if (el.hidden || el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
    return false;
  }

  function hasHiddenAncestor(node: Node | null): boolean {
    let current: Node | null = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement || null;
    while (current && current !== document) {
      if (current.nodeType === Node.ELEMENT_NODE && isHiddenElement(current)) return true;
      current = (current as Element).parentElement;
    }
    return false;
  }

  function nearestElement(node: Node): Element | null {
    return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  }

  function inferRole(el: any): string | null {
    const explicit = el.getAttribute?.('role');
    if (explicit) return explicit;
    const tag = el.tagName?.toLowerCase?.() || '';
    const type = String(el.getAttribute?.('type') || '').toLowerCase();
    const roleMap: Record<string, string> = {
      a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'img',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      li: 'listitem', ul: 'list', ol: 'list', table: 'table'
    };
    if (tag === 'input') return type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' || type === 'button' ? 'button' : 'textbox';
    return roleMap[tag] || null;
  }

  function selectorFor(el: any): string | null {
    if (!el?.tagName) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return `${tag}[data-testid="${CSS.escape(testId)}"]`;
    if (typeof el.className === 'string') {
      const cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c: string) => CSS.escape(c)).join('.');
      if (cls) return `${tag}.${cls}`;
    }
    return tag;
  }

  function addRun(text: string, rect: DOMRect | ClientRect, el: Element | null, source = 'text'): void {
    const normalizedText = normalize(text);
    if (!normalizedText) return;
    const keyText = normalizedText.length > 500 ? normalizedText.slice(0, 500) : normalizedText;
    const outRect = rectFromDomRect(rect);
    const key = `${keyText}|${outRect.x}|${outRect.y}|${outRect.width}|${outRect.height}`;
    if (seen.has(key)) return;
    seen.add(key);
    totalTextChars += normalizedText.length;

    const entry = {
      id: `t${entries.length + 1}`,
      text: normalizedText,
      normalizedText,
      rect: outRect,
      tag: el?.tagName?.toLowerCase?.() || null,
      role: el ? inferRole(el) : null,
      selector: el ? selectorFor(el) : null,
      source
    };
    entries.push(entry);
    if (runs.length < maxTextRuns) {
      runs.push(entry);
    } else {
      runLimited = true;
    }
  }

  function addTextNode(node: Text): void {
    if (totalTextChars >= maxArtifactChars) return;
    if (hasHiddenAncestor(node)) return;
    const normalizedText = normalize(node.nodeValue || '');
    if (!normalizedText) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = firstReachableRect(range.getClientRects());
    range.detach?.();
    if (!rect) return;
    addRun(normalizedText, rect, nearestElement(node), 'text');
  }

  function controlText(el: any): string {
    const tag = el.tagName?.toLowerCase?.() || '';
    if (tag === 'input' || tag === 'textarea') {
      if (isSensitiveControl(el)) return el.getAttribute('placeholder') || (el.value ? '[redacted]' : '');
      return el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
    }
    if (tag === 'select') return el.options?.[el.selectedIndex]?.text || el.getAttribute('aria-label') || '';
    if (tag === 'img') return el.getAttribute('alt') || el.getAttribute('aria-label') || '';
    return el.getAttribute('aria-label') || el.getAttribute('title') || '';
  }

  function addControl(el: Element): void {
    if (hasHiddenAncestor(el)) return;
    const text = controlText(el);
    if (!text) return;
    const rect = firstReachableRect(el.getClientRects());
    if (!rect) return;
    addRun(text, rect, el, 'control');
  }

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node) {
      if (!node.nodeValue || !normalize(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      return hasHiddenAncestor(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) { if (totalTextChars >= maxArtifactChars) break; addTextNode(walker.currentNode as Text); }

  for (const el of Array.from(document.querySelectorAll(controlSelector))) addControl(el);

  entries.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x) || a.id.localeCompare(b.id));
  runs.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x) || a.id.localeCompare(b.id));
  const sortedText = entries.map(run => run.text).join('\n');
  const text = sortedText.slice(0, maxChars);
  const artifactText = sortedText.length > maxChars ? sortedText.slice(0, maxArtifactChars) : undefined;
  const truncated = sortedText.length > maxChars || sortedText.length > maxArtifactChars;
  const textRuns = includeRuns ? runs : undefined;

  return {
    text,
    textRuns,
    runs: textRuns,
    truncated,
    artifactText: truncated ? artifactText || sortedText.slice(0, maxArtifactChars) : undefined,
    caps: {
      maxChars,
      maxTextRuns,
      maxArtifactChars,
      textRunCount: runs.length,
      totalTextRunCount: entries.length,
      textRunsTruncated: runLimited,
      totalTextChars,
      textChars: Math.min(text.length, maxChars),
      scope,
      iframeBehavior: 'top-frame-only'
    },
    url: window.location.href,
    title: document.title
  };
}


export function getDocumentTextSnapshot(options: any = {}) {
  const maxChars = Number.isFinite(options?.maxChars) ? Math.max(0, Math.min(Number(options.maxChars), 200000)) : 12000;
  const maxArtifactChars = Number.isFinite(options?.maxArtifactChars) ? Math.max(maxChars, Math.min(Number(options.maxArtifactChars), 200000)) : Math.max(maxChars, 200000);
  const includeRuns = options?.includeRuns === true;
  const raw = (document.body?.innerText || document.documentElement?.innerText || '').replace(/\s+\n/g, '\n').trim();
  const text = raw.slice(0, maxChars);
  const truncated = raw.length > maxChars || raw.length > maxArtifactChars;
  const textRuns = includeRuns ? [] : undefined;
  return {
    text,
    textRuns,
    runs: textRuns,
    truncated,
    artifactText: truncated ? raw.slice(0, maxArtifactChars) : undefined,
    caps: {
      maxChars,
      maxArtifactChars,
      textChars: Math.min(raw.length, maxChars),
      totalTextChars: raw.length,
      textRunCount: 0,
      totalTextRunCount: 0,
      textRunsTruncated: false,
      scope: 'document',
      extraction: 'body.innerText',
      iframeBehavior: 'top-frame-only'
    },
    url: window.location.href,
    title: document.title
  };
}
