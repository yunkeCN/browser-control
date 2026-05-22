// ─── Legacy Accessibility Tree Snapshot ──────────────────────────────
//
// The canonical command-path snapshot runtime lives in
// src/extension/service-worker/page-runtime/snapshot.ts and is injected by the
// service worker for the `snapshot` command. This content-script helper is kept
// for legacy/debug surfaces only; keep externally documented snapshot semantics
// aligned with the service-worker runtime.

type SnapshotElement = Element & HTMLElement & HTMLInputElement & HTMLSelectElement;

export function getAccessibilitySnapshot(maxDepth = 20): any {
  const elements: any[] = [];
  let counter = 0;

  function walk(node: Node, depth: number): void {
    if (depth > maxDepth) return;
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as SnapshotElement;
    const tag = el.tagName.toLowerCase();
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    // Skip invisible elements
    if (style.display === 'none' || style.visibility === 'hidden') return;
    if (rect.width === 0 && rect.height === 0 && tag !== 'input') return;

    const id = `@e${++counter}`;

    // Tag element for @e reference lookups
    el.setAttribute('data-agent-id', id);

    const element = {
      id,
      tag,
      role: getRole(el),
      name: getAccessibleName(el),
      visibleText: getVisibleText(el),
      boundingBox: {
        x: Math.round(rect.x + window.scrollX),
        y: Math.round(rect.y + window.scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      cssSelector: buildCssSelector(el),
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
      href: el.getAttribute('href') || null,
      enabled: !(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      visible: true,
      attributes: {
        type: el.getAttribute('type') || null,
        value: (el.value || '').substring(0, 200) || null,
        checked: el.checked || null,
        placeholder: el.getAttribute('placeholder') || null,
        alt: el.getAttribute('alt') || null
      }
    };

    elements.push(element);

    // Walk children
    for (const child of el.children) {
      walk(child, depth + 1);
    }
  }

  walk(document.body, 0);

  return {
    elements,
    url: window.location.href,
    title: document.title,
    totalElements: elements.length
  };
}

export function getRole(el: SnapshotElement): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;

  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const roleMap: Record<string, string> = {
    a: 'link', button: 'button',
    input: type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' :
           type === 'submit' || type === 'button' ? 'button' : 'textbox',
    select: 'combobox', textarea: 'textbox', img: 'img',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', nav: 'navigation', main: 'main',
    form: 'form', table: 'table', li: 'listitem',
    ul: 'list', ol: 'list', video: 'video', audio: 'audio',
    dialog: 'dialog', details: 'group', summary: 'button',
    hr: 'separator', header: 'banner', footer: 'contentinfo'
  };
  return roleMap[tag] || 'generic';
}

export function getAccessibleName(el: SnapshotElement): string {
  return el.getAttribute('aria-label') ||
         el.getAttribute('aria-labelledby') ||
         el.getAttribute('title') ||
         el.getAttribute('alt') ||
         el.getAttribute('placeholder') ||
         el.getAttribute('name') ||
         '';
}

export function getVisibleText(el: SnapshotElement): string {
  if (['input', 'textarea'].includes(el.tagName.toLowerCase())) {
    return el.value || el.placeholder || '';
  }
  if (el.tagName.toLowerCase() === 'img') return el.alt || '';
  if (el.tagName.toLowerCase() === 'select') {
    return el.options[el.selectedIndex]?.text || '';
  }
  // For containers, get direct text only (first level)
  const directText = [];
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      directText.push(child.textContent);
    }
  }
  const text = directText.join(' ').trim();
  if (text) return text.substring(0, 200);
  // Fallback to innerText for leaf elements
  if (!el.children.length) {
    return (el.innerText || el.textContent || '').trim().substring(0, 200);
  }
  return '';
}

export function buildCssSelector(el: SnapshotElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;

  const tag = el.tagName.toLowerCase();
  const classes = (typeof el.className === 'string')
    ? el.className.trim().split(/\s+/).filter((c: string) => c && !c.match(/^\d/)).slice(0, 2)
    : [];

  if (classes.length > 0) {
    return `${tag}.${classes.map((c: string) => CSS.escape(c)).join('.')}`;
  }

  // Use nth-child for elements without good identifiers
  if (el.parentElement) {
    const siblings = [...el.parentElement.children].filter((c: Element) => c.tagName === el.tagName);
    if (siblings.length > 1 && siblings.includes(el)) {
      const index = siblings.indexOf(el) + 1;
      return `${tag}:nth-of-type(${index})`;
    }
  }

  return tag;
}

// ─── DOM Snapshot (Playwright-style) ──────────────────────────────────

export function getDomSnapshot(): string {
  const serializer = new XMLSerializer();

  function cleanElement(el: Element): Element {
    const clone = el.cloneNode(false) as Element;
    // Only keep semantic attributes
    const keepAttrs = ['id', 'class', 'type', 'name', 'value', 'placeholder',
      'href', 'src', 'alt', 'title', 'aria-label', 'aria-role', 'role',
      'data-testid', 'data-test-id', 'checked', 'disabled', 'selected',
      'for', 'target', 'rel', 'action', 'method'];
    for (const attr of el.attributes || []) {
      if (!keepAttrs.includes(attr.name) && !attr.name.startsWith('data-')) {
        clone.removeAttribute(attr.name);
      }
    }
    return clone;
  }

  function snapshot(node: Node, depth = 0): string {
    if (depth > 50) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent || '').trim();
      return t ? `"${t.substring(0, 200)}"` : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    const cleaned = cleanElement(element);
    const attrs = [...cleaned.attributes].map(a => `${a.name}="${a.value}"`).join(' ');

    const children: string[] = [];
    for (const child of element.childNodes) {
      children.push(snapshot(child, depth + 1));
    }

    const inner = children.filter(Boolean).join(' ');
    if (['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tag)) {
      return `<${tag}${attrs ? ' ' + attrs : ''}/>`;
    }
    return `<${tag}${attrs ? ' ' + attrs : ''}>${inner}</${tag}>`;
  }

  return snapshot(document.body);
}
