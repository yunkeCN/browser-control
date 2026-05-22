// ─── Content script functions (serialized for executeScript) ─────────

export function getAccessibilitySnapshot(options: any = {}) {
  const maxDepthOption = Number.isFinite(options?.maxDepth) ? Math.max(0, Math.min(Number(options.maxDepth), 50)) : null;
  const roleFilter = Array.isArray(options?.roles) ? new Set(options.roles.map((r: unknown) => String(r).toLowerCase())) : null;
  const tagFilter = Array.isArray(options?.tags) ? new Set(options.tags.map((t: unknown) => String(t).toLowerCase())) : null;
  const hasVisibleText = options?.hasVisibleText === true;
  const textIncludes = options?.textIncludes ? String(options.textIncludes) : '';
  const viewportOnly = options?.viewportOnly === true;
  const maxElements = Number.isFinite(options?.maxElements) ? Math.max(0, Number(options.maxElements)) : Infinity;
  const stats = {
    scanned: 0,
    matched: 0,
    returned: 0,
    truncated: false
  };

  const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'form',
    'img', 'video', 'audio', 'iframe', 'details', 'summary', 'option', 'label']);
  const contentTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'div', 'li',
    'td', 'th', 'pre', 'code', 'blockquote']);
  const inlineTextTags = new Set(['span', 'strong', 'em', 'b', 'i', 'u', 'small', 'mark', 'code', 'a', 'label']);

  // Build a simplified accessibility/DOM tree for agent interaction. This is
  // intentionally not a full page text dump; use get_text for reading prose.
  function buildA11yTree(node: Node): any[] | null {
    if (!node) return null;

    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode: (el: Node) => {
          const element = el as Element;
          const tag = element.tagName.toLowerCase();
          const depth = getDepthFromBody(element);
          if (maxDepthOption !== null && depth > maxDepthOption) return NodeFilter.FILTER_REJECT;
          if (tagFilter && !tagFilter.has(tag)) return NodeFilter.FILTER_SKIP;

          // Only include visible, interactable/contextual elements.
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return NodeFilter.FILTER_SKIP;
          const style = window.getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_SKIP;
          if (viewportOnly && !isInViewport(rect)) return NodeFilter.FILTER_SKIP;

          const hasClickHandler = (element as HTMLElement).onclick || element.getAttribute('onclick');

          if (interactiveTags.has(tag) || hasClickHandler || contentTags.has(tag)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    const result: any[] = [];
    let lastId = getExistingAgentIdMax();

    while (walker.nextNode()) {
      const el = walker.currentNode as any;
      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const aria = {
        role: el.getAttribute('role') || el.getAttribute('aria-role') || inferRole(el),
        name: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
              el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '',
        description: el.getAttribute('aria-description') || ''
      };

      // Generate CSS selector
      let cssSelector = tag;
      if (el.id) cssSelector = `#${CSS.escape(el.id)}`;
      else if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\s+/).slice(0, 2).map((c: string) => CSS.escape(c)).join('.');
        if (cls) cssSelector = `${tag}.${cls}`;
      }

      stats.scanned += 1;
      const visibleText = getVisibleText(el);
      const accessibleName = aria.name || visibleText?.substring(0, 100) || '';
      const text = visibleText || accessibleName || '';
      const include =
        (!roleFilter || roleFilter.has(String(aria.role || '').toLowerCase())) &&
        (!hasVisibleText || Boolean(text)) &&
        (!textIncludes || String(text).includes(textIncludes));

      if (!include) continue;
      stats.matched += 1;
      if (result.length >= maxElements) {
        stats.truncated = true;
        continue;
      }

      const id = `@e${++lastId}`;

      // Tag returned elements so @e references can be resolved later by findElement.
      el.setAttribute('data-agent-id', id);

      const attributes = getSafeAttributes(el);
      const elementRecord = {
        id,
        tag,
        role: aria.role,
        name: accessibleName,
        description: aria.description,
        cssSelector,
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
        href: el.getAttribute('href') || null,
        visibleText: visibleText?.substring(0, 200) || null,
        boundingBox: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        visible: style.display !== 'none' && style.visibility !== 'hidden',
        attributes
      };
      result.push(elementRecord);
    }

    stats.returned = result.length;
    return result;
  }

  function inferRole(el: any): string {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');
    const roleMap: Record<string, string> = {
      a: 'link', button: 'button', input: type === 'checkbox' ? 'checkbox' :
        type === 'radio' ? 'radio' : type === 'submit' ? 'button' : 'textbox',
      select: 'combobox', textarea: 'textbox', img: 'img',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      nav: 'navigation', main: 'main', form: 'form',
      table: 'table', li: 'listitem', ul: 'list', ol: 'list',
      video: 'video', audio: 'audio'
    };
    return roleMap[tag] || 'generic';
  }

  function getVisibleText(el: any): string {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (isSensitiveField(el)) return el.getAttribute('placeholder') || (el.value ? '[redacted]' : '');
      return el.value || el.getAttribute('placeholder') || '';
    }
    if (tag === 'select') return el.options?.[el.selectedIndex]?.text || '';
    if (tag === 'img') return el.alt || el.getAttribute('alt') || '';

    const directText = normalizeText(getDirectText(el));
    if (directText) return directText.substring(0, 200);

    if (tag === 'td' || tag === 'th' || tag === 'li') {
      const inlineText = normalizeText(getDirectAndInlineText(el));
      if (inlineText) return inlineText.substring(0, 200);
    }

    const role = el.getAttribute('role') || inferRole(el);
    const hasClickHandler = el.onclick || el.getAttribute('onclick');
    const interactive = interactiveTags.has(tag) || hasClickHandler || (role && role !== 'generic');
    if (interactive || !el.children?.length) {
      return normalizeText(el.innerText || el.textContent || '').substring(0, 200);
    }
    return '';
  }

  function getDirectText(el: any): string {
    const parts: string[] = [];
    for (const child of Array.from(el.childNodes || []) as any[]) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent || '');
    }
    return parts.join(' ');
  }

  function getDirectAndInlineText(el: any): string {
    const parts: string[] = [];
    for (const child of Array.from(el.childNodes || []) as any[]) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.textContent || '');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const childEl = child as any;
      const childTag = childEl.tagName?.toLowerCase?.() || '';
      if (inlineTextTags.has(childTag) && !childEl.children?.length) {
        parts.push(childEl.innerText || childEl.textContent || '');
      }
    }
    return parts.join(' ');
  }

  function normalizeText(value: string): string {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isInViewport(rect: DOMRect): boolean {
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
  }

  function getDepthFromBody(el: Element): number {
    let depth = 0;
    let current: Element | null = el;
    while (current && current !== document.body) {
      depth += 1;
      current = current.parentElement;
    }
    return current === document.body ? depth : Number.MAX_SAFE_INTEGER;
  }

  function getExistingAgentIdMax(): number {
    let max = 0;
    for (const el of Array.from(document.querySelectorAll('[data-agent-id^="@e"]'))) {
      const match = /^@e(\d+)$/.exec(el.getAttribute('data-agent-id') || '');
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  function isSensitiveField(el: any): boolean {
    const tag = el.tagName?.toLowerCase?.() || '';
    if (tag !== 'input' && tag !== 'textarea') return false;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden') return true;
    const haystack = [
      type,
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('autocomplete'),
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder')
    ].filter(Boolean).join(' ');
    return /pass(word)?|token|secret|api[-_\s]?key|auth|credential|session|cookie|csrf|jwt|bearer|private|access[-_\s]?key/i.test(haystack);
  }

  function getSafeAttributes(el: any): any {
    const tag = el.tagName.toLowerCase();
    const supportsValue = tag === 'input' || tag === 'textarea';
    const rawValue = supportsValue ? String(el.value || '') : '';
    const sensitive = supportsValue && isSensitiveField(el);
    return {
      type: el.getAttribute('type') || null,
      value: supportsValue
        ? (sensitive ? (rawValue ? '[redacted]' : null) : rawValue.substring(0, 100) || null)
        : null,
      valueLength: supportsValue && rawValue ? rawValue.length : null,
      checked: el.checked || null,
      placeholder: el.getAttribute('placeholder') || null,
      redacted: sensitive || null
    };
  }

  const elements = buildA11yTree(document.body) || [];
  return {
    schemaVersion: 2,
    semantics: 'compact-dom-v2',
    elements,
    url: window.location.href,
    title: document.title,
    stats,
    totalBeforeFilter: stats.scanned,
    returned: stats.returned,
    truncated: stats.truncated,
    filters: {
      maxDepth: maxDepthOption,
      roles: options?.roles || null,
      tags: options?.tags || null,
      hasVisibleText,
      textIncludes: textIncludes || null,
      viewportOnly,
      maxElements: Number.isFinite(maxElements) ? maxElements : null
    }
  };
}
