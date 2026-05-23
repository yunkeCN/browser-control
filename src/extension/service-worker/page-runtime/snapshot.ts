// ─── Content script functions (serialized for executeScript) ─────────

export function getAccessibilitySnapshot(options: any = {}) {
  const agentRefs = installAgentRefRuntime();
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

      // Tag returned elements so @e references can be resolved and validated
      // later by actions. References are structural and revisioned; old
      // revisions fail closed instead of resolving to a changed target.
      const agentRef = agentRefs.assign(el);
      const id = agentRef.id;

      const attributes = getSafeAttributes(el);
      const elementRecord = {
        id,
        structureId: agentRef.structureId,
        revision: agentRef.revision,
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

  function installAgentRefRuntime(): any {
    const root = window as any;
    if (root.__browserControlAgentRef?.version === 1) return root.__browserControlAgentRef;

    type RegistryEntry = {
      revision: number;
      fingerprint: string;
      id: string;
      label: string;
      lastSeenAt: number;
    };
    type Registry = { version: number; entries: Record<string, RegistryEntry> };

    const registry: Registry = root.__browserControlAgentRefRegistry?.version === 1
      ? root.__browserControlAgentRefRegistry
      : { version: 1, entries: {} };
    root.__browserControlAgentRefRegistry = registry;

    function normalizeText(value: unknown, max = 160): string {
      return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function inferRoleForRef(el: any): string {
      const explicit = el.getAttribute?.('role') || el.getAttribute?.('aria-role');
      if (explicit) return String(explicit);
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.getAttribute?.('type') || '').toLowerCase();
      const roleMap: Record<string, string> = {
        a: 'link',
        button: 'button',
        input: type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' || type === 'button' ? 'button' : 'textbox',
        select: 'combobox',
        textarea: 'textbox',
        img: 'img',
        h1: 'heading',
        h2: 'heading',
        h3: 'heading',
        h4: 'heading',
        h5: 'heading',
        h6: 'heading',
        nav: 'navigation',
        main: 'main',
        form: 'form',
        table: 'table',
        li: 'listitem',
        ul: 'list',
        ol: 'list',
        dialog: 'dialog'
      };
      return roleMap[tag] || 'generic';
    }

    function directText(el: any): string {
      const parts: string[] = [];
      for (const child of Array.from(el.childNodes || []) as any[]) {
        if (child.nodeType === Node.TEXT_NODE) parts.push(child.textContent || '');
      }
      return normalizeText(parts.join(' '), 160);
    }

    function visibleTextForRef(el: any): string {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return normalizeText(el.getAttribute?.('placeholder') || '', 120);
      if (tag === 'select') return normalizeText(el.options?.[el.selectedIndex]?.text || '', 120);
      if (tag === 'img') return normalizeText(el.getAttribute?.('alt') || el.alt || '', 120);
      return directText(el) || normalizeText(el.getAttribute?.('aria-label') || el.textContent || '', 160);
    }

    function accessibleNameForRef(el: any): string {
      return normalizeText(
        el.getAttribute?.('aria-label') ||
        el.getAttribute?.('aria-labelledby') ||
        el.getAttribute?.('title') ||
        el.getAttribute?.('alt') ||
        el.getAttribute?.('placeholder') ||
        '',
        160
      );
    }

    function stableAttr(el: any): string {
      const testId = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id');
      if (testId) return `test=${normalizeText(testId, 80)}`;
      const id = el.getAttribute?.('id') || '';
      if (id && !/[0-9a-f]{8,}|react-select-\d+|ember\d+|^[:_\-a-z]*\d{4,}$/i.test(id)) {
        return `id=${normalizeText(id, 80)}`;
      }
      const name = el.getAttribute?.('name') || '';
      if (name) return `name=${normalizeText(name, 80)}`;
      return '';
    }

    function siblingIndex(el: Element): number {
      const parent = el.parentElement;
      if (!parent) return 1;
      const tag = el.tagName;
      let index = 0;
      for (const child of Array.from(parent.children)) {
        if (child.tagName === tag) index += 1;
        if (child === el) return index || 1;
      }
      return 1;
    }

    function structuralSegment(el: any): string {
      const tag = String(el.tagName || '').toLowerCase();
      const role = inferRoleForRef(el);
      const attr = stableAttr(el);
      const index = siblingIndex(el);
      const anchor = attr && attr.startsWith('id=') ? `[${attr}]` : `${attr ? `[${attr}]` : ''}:nth(${index})`;
      return `${tag}[role=${role}]${anchor}`;
    }

    function urlScope(): string {
      try {
        const url = new URL(window.location.href);
        return `${url.origin}${url.pathname}`;
      } catch {
        return String(window.location.href || '').split('?')[0].split('#')[0];
      }
    }

    function structuralPath(el: Element): string {
      const parts: string[] = [];
      let current: Element | null = el;
      let depth = 0;
      while (current && current !== document.documentElement && depth < 8) {
        parts.unshift(structuralSegment(current));
        if (current === document.body) break;
        current = current.parentElement;
        depth += 1;
      }
      return `top|${urlScope()}|${parts.join('>')}`;
    }

    function hashString(value: string): string {
      let hash = 2166136261;
      for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36).padStart(6, '0');
    }

    function computeStructureId(el: Element): string {
      return hashString(structuralPath(el));
    }

    function fingerprintSource(el: any): string {
      const tag = String(el.tagName || '').toLowerCase();
      const href = tag === 'a' ? normalizeText(el.getAttribute?.('href') || '', 200) : '';
      return [
        `tag=${tag}`,
        `role=${inferRoleForRef(el)}`,
        `name=${accessibleNameForRef(el)}`,
        `text=${visibleTextForRef(el)}`,
        `href=${href}`,
        `type=${normalizeText(el.getAttribute?.('type') || '', 40)}`,
        `test=${normalizeText(el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id') || '', 80)}`,
        `ariaChecked=${normalizeText(el.getAttribute?.('aria-checked') || '', 20)}`,
        `ariaSelected=${normalizeText(el.getAttribute?.('aria-selected') || '', 20)}`
      ].join('|');
    }

    function computeFingerprint(el: Element): string {
      return hashString(fingerprintSource(el));
    }

    function labelFor(el: any): string {
      const role = inferRoleForRef(el);
      const text = accessibleNameForRef(el) || visibleTextForRef(el);
      return normalizeText(`${role} ${text}`.trim(), 120);
    }

    function writeMetadata(el: any, structureId: string, revision: number, fingerprint: string, id: string, label: string): void {
      try {
        el.setAttribute('data-agent-id', id);
        el.setAttribute('data-agent-structure-id', structureId);
        el.setAttribute('data-agent-revision', String(revision));
        el.setAttribute('data-agent-fingerprint', fingerprint);
        el.setAttribute('data-agent-label', label);
      } catch {
        // Ignore metadata write failures on unusual nodes.
      }
    }

    function assign(el: Element): any {
      const structureId = computeStructureId(el);
      const fingerprint = computeFingerprint(el);
      const label = labelFor(el);
      const existing = registry.entries[structureId];
      const revision = existing
        ? (existing.fingerprint === fingerprint ? existing.revision : existing.revision + 1)
        : 1;
      const id = `@e${structureId}_${revision}`;
      registry.entries[structureId] = { revision, fingerprint, id, label, lastSeenAt: Date.now() };
      writeMetadata(el, structureId, revision, fingerprint, id, label);
      return { id, structureId, revision, fingerprint, label };
    }

    function parse(ref: string): any {
      const match = /^@e([a-z0-9]+)_(\d+)$/i.exec(String(ref || ''));
      if (!match) return null;
      return { structureId: match[1], revision: Number(match[2]) };
    }

    function attrSelector(name: string, value: string): string {
      return `[${name}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    }

    function describe(el: Element | null): any {
      if (!el || !el.tagName) return null;
      return {
        id: el.getAttribute('data-agent-id') || null,
        tag: el.tagName.toLowerCase(),
        role: inferRoleForRef(el),
        label: labelFor(el),
        text: visibleTextForRef(el)
      };
    }

    function stale(ref: string, parsed: any, current: Element | null, reason: string): any {
      const entry = registry.entries[parsed.structureId] || null;
      const currentId = current
        ? `@e${computeStructureId(current)}_${entry && entry.fingerprint !== computeFingerprint(current) ? entry.revision + 1 : Number(current.getAttribute('data-agent-revision') || entry?.revision || parsed.revision)}`
        : entry?.id || null;
      return {
        error: `${ref} is stale. Take a fresh snapshot.`,
        code: 'STALE_ELEMENT_REFERENCE',
        recoverable: true,
        retryable: true,
        selector: ref,
        reason,
        expected: { structureId: parsed.structureId, revision: parsed.revision },
        current: current ? { ...describe(current), id: currentId } : (entry ? { id: entry.id, label: entry.label } : null),
        nextStep: 'Take a fresh snapshot and retry with the new @e reference.'
      };
    }

    function findSameStructure(structureId: string): Element | null {
      const marked = document.querySelector(attrSelector('data-agent-structure-id', structureId));
      if (marked) return marked;
      const all = Array.from(document.body?.querySelectorAll?.('*') || []).slice(0, 5000) as Element[];
      for (const el of all) {
        try {
          if (computeStructureId(el) === structureId) return el;
        } catch {
          // Keep scanning if an unusual node cannot be fingerprinted.
        }
      }
      return null;
    }

    function resolve(ref: string): any {
      const parsed = parse(ref);
      if (!parsed) {
        return {
          error: `Invalid @e reference format: ${ref}. Take a fresh snapshot.`,
          code: 'INVALID_ELEMENT_REFERENCE',
          recoverable: true,
          retryable: true,
          selector: ref
        };
      }

      const exact = document.querySelector(attrSelector('data-agent-id', ref));
      if (!exact) {
        const sameStructure = findSameStructure(parsed.structureId);
        if (sameStructure) return stale(ref, parsed, sameStructure, 'reference revision is no longer attached');
        return {
          error: `Element not found: ${ref}`,
          code: 'NOT_FOUND',
          recoverable: true,
          retryable: true,
          selector: ref,
          nextStep: 'Take a fresh snapshot and retry with the new @e reference.'
        };
      }

      const currentStructureId = computeStructureId(exact);
      const currentFingerprint = computeFingerprint(exact);
      const storedStructureId = exact.getAttribute('data-agent-structure-id') || parsed.structureId;
      const storedFingerprint = exact.getAttribute('data-agent-fingerprint') || '';
      const storedRevision = Number(exact.getAttribute('data-agent-revision') || parsed.revision);
      const entry = registry.entries[parsed.structureId] || null;
      if (storedStructureId !== parsed.structureId || currentStructureId !== parsed.structureId) {
        return stale(ref, parsed, exact, 'element structural location changed');
      }
      if (storedRevision !== parsed.revision || (entry && entry.revision !== parsed.revision)) {
        return stale(ref, parsed, exact, 'reference revision changed');
      }
      if (storedFingerprint && currentFingerprint !== storedFingerprint) {
        return stale(ref, parsed, exact, 'element fingerprint changed');
      }
      return { element: exact, id: ref, structureId: parsed.structureId, revision: parsed.revision };
    }

    root.__browserControlAgentRef = {
      version: 1,
      assign,
      resolve,
      computeStructureId,
      computeFingerprint,
      parse
    };
    return root.__browserControlAgentRef;
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
