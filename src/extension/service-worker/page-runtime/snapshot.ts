export function getAccessibilitySnapshot(options: any = {}) {
  const agentRefs = installAgentRefRuntime();
  const roleFilter = Array.isArray(options?.roles) ? new Set(options.roles.map((r: unknown) => String(r).toLowerCase())) : null;
  const tagFilter = Array.isArray(options?.tags) ? new Set(options.tags.map((t: unknown) => String(t).toLowerCase())) : null;
  const hasVisibleText = options?.hasVisibleText === true;
  const textIncludes = options?.textIncludes ? String(options.textIncludes) : '';
  const viewportOnly = options?.viewportOnly === true;
  const renderBoxes = options?.boxes === true || options?.includeBoxes === true;
  const stats = {
    visited: 0,
    emitted: 0,
    text: 0,
    refs: 0,
    filtered: 0,
    frames: 0,
    inaccessibleFrames: 0,
    truncated: false
  };

  type Box = { x: number; y: number; width: number; height: number; visible: boolean; inline: boolean; cursor: string };
  type AriaNode = {
    role: string;
    name: string;
    tag: string;
    ref?: string;
    children: Array<AriaNode | string>;
    props: Record<string, string>;
    box: Box;
    receivesPointerEvents: boolean;
    active?: boolean;
    checked?: boolean | 'mixed';
    disabled?: boolean;
    expanded?: boolean;
    level?: number;
    pressed?: boolean | 'mixed';
    selected?: boolean;
    element?: Element;
  };

  const visited = new Set<Node>();

  function generateTree(rootElement: Element): AriaNode {
    const root: AriaNode = {
      role: 'fragment',
      name: '',
      tag: '#fragment',
      children: [],
      props: {},
      box: computeBox(rootElement),
      receivesPointerEvents: true,
      element: rootElement
    };
    visit(root, rootElement, true);
    normalizeStringChildren(root);
    normalizeGenericRoles(root);
    return applyFilters(root);
  }

  function visit(parentAriaNode: AriaNode, node: Node, parentElementVisible: boolean): void {
    if (!node || visited.has(node))
      return;
    visited.add(node);

    if (node.nodeType === Node.TEXT_NODE) {
      const text = String((node as any).nodeValue ?? (node as any).textContent ?? '').replace(/\s+/g, ' ');
      if (parentElementVisible && parentAriaNode.role !== 'textbox' && text.trim())
        parentAriaNode.children.push(text);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE)
      return;

    const element = node as Element;
    const tag = tagName(element);
    if (isNeverRenderedTag(tag))
      return;

    stats.visited += 1;
    const ariaVisible = !isElementHiddenForAria(element);
    const styleVisible = isElementVisible(element);
    const box = computeBox(element);
    const inViewport = !viewportOnly || isInViewport(box);
    const visible = inViewport && (ariaVisible || styleVisible);

    const childAriaNode = visible ? toAriaNode(element, box) : null;
    if (childAriaNode) {
      parentAriaNode.children.push(childAriaNode);
      stats.emitted += 1;
      if (childAriaNode.ref)
        stats.refs += 1;
    }

    processElement(childAriaNode || parentAriaNode, element, visible);
  }

  function processElement(ariaNode: AriaNode, element: Element, parentElementVisible: boolean): void {
    const display = getStyle(element).display || 'inline';
    const treatAsBlock = display !== 'inline' || element.nodeName === 'BR' ? ' ' : '';
    if (treatAsBlock)
      ariaNode.children.push(treatAsBlock);

    for (const child of childNodesOf(element)) {
      if (!(child as any).assignedSlot)
        visit(ariaNode, child, parentElementVisible);
    }

    const shadowRoot = (element as any).shadowRoot;
    if (shadowRoot) {
      for (const child of childNodesOf(shadowRoot))
        visit(ariaNode, child, parentElementVisible);
    }

    if (tagName(element) === 'iframe') {
      stats.frames += 1;
      try {
        const frameDocument = (element as HTMLIFrameElement).contentDocument;
        if (frameDocument?.body)
          visit(ariaNode, frameDocument.body, parentElementVisible);
      } catch {
        stats.inaccessibleFrames += 1;
      }
    }

    if (treatAsBlock)
      ariaNode.children.push(treatAsBlock);

    if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0])
      ariaNode.children = [];

    if (ariaNode.role === 'link') {
      const href = element.getAttribute('href');
      if (href)
        ariaNode.props.url = href;
    }

    if (ariaNode.role === 'textbox') {
      const placeholder = element.getAttribute('placeholder');
      if (placeholder && placeholder !== ariaNode.name)
        ariaNode.props.placeholder = placeholder;
    }
  }

  function toAriaNode(element: Element, box: Box): AriaNode | null {
    const role = getAriaRole(element);
    if (!role || role === 'presentation' || role === 'none')
      return null;

    const name = normalizeText(getElementAccessibleName(element), 900);
    const node: AriaNode = {
      role,
      name,
      tag: tagName(element),
      children: [],
      props: {},
      box,
      receivesPointerEvents: receivesPointerEvents(element, box),
      active: isActiveElement(element),
      element
    };

    const checked = getAriaChecked(element);
    if (checked !== undefined)
      node.checked = checked;
    const disabled = getAriaDisabled(element);
    if (disabled)
      node.disabled = true;
    const expanded = getBooleanAria(element, 'aria-expanded');
    if (expanded !== undefined)
      node.expanded = expanded;
    const level = getAriaLevel(element, role);
    if (level !== undefined)
      node.level = level;
    const pressed = getMixedBooleanAria(element, 'aria-pressed');
    if (pressed !== undefined)
      node.pressed = pressed;
    const selected = getBooleanAria(element, 'aria-selected');
    if (selected !== undefined)
      node.selected = selected;

    if (isTextInput(element)) {
      const value = String((element as HTMLInputElement | HTMLTextAreaElement).value || '');
      if (value)
        node.children = [isSensitiveField(element) ? '[redacted]' : value];
    }

    if (shouldAssignRef(node)) {
      const assigned = agentRefs.assign(element);
      node.ref = assigned.id;
    }

    return node;
  }

  function shouldAssignRef(node: AriaNode): boolean {
    return node.box.visible && node.receivesPointerEvents;
  }

  function applyFilters(root: AriaNode): AriaNode {
    if (!roleFilter && !tagFilter && !hasVisibleText && !textIncludes)
      return root;

    const clone = cloneNode(root);
    const filteredChildren: Array<AriaNode | string> = [];
    for (const child of root.children) {
      const filtered = filterChild(child);
      if (filtered)
        filteredChildren.push(filtered);
    }
    clone.children = filteredChildren;
    return clone;
  }

  function filterChild(child: AriaNode | string): AriaNode | string | null {
    if (typeof child === 'string') {
      const text = normalizeText(child);
      if (!text)
        return null;
      if ((roleFilter || tagFilter) && !textIncludes)
        return null;
      if (textIncludes && !text.includes(textIncludes))
        return null;
      return child;
    }

    const childMatches = nodeMatchesFilter(child);
    const filtered = cloneNode(child);
    filtered.children = [];
    for (const grandChild of child.children) {
      const kept = filterChild(grandChild);
      if (kept)
        filtered.children.push(kept);
    }
    if (childMatches || filtered.children.length)
      return filtered;
    stats.filtered += 1;
    return null;
  }

  function nodeMatchesFilter(node: AriaNode): boolean {
    if (roleFilter && !roleFilter.has(node.role.toLowerCase()))
      return false;
    if (tagFilter && !tagFilter.has(node.tag.toLowerCase()))
      return false;

    const text = nodeSearchText(node);
    if (hasVisibleText && !text)
      return false;
    if (textIncludes && !text.includes(textIncludes))
      return false;
    return true;
  }

  function cloneNode(node: AriaNode): AriaNode {
    return {
      ...node,
      children: [...node.children],
      props: { ...node.props }
    };
  }

  function normalizeStringChildren(root: AriaNode): void {
    const flush = (buffer: string[], normalized: Array<AriaNode | string>) => {
      if (!buffer.length)
        return;
      const text = normalizeText(buffer.join(''));
      if (text) {
        normalized.push(text);
        stats.text += 1;
      }
      buffer.length = 0;
    };

    const visitNode = (node: AriaNode) => {
      const normalized: Array<AriaNode | string> = [];
      const buffer: string[] = [];
      for (const child of node.children) {
        if (typeof child === 'string') {
          buffer.push(child);
        } else {
          flush(buffer, normalized);
          visitNode(child);
          normalized.push(child);
        }
      }
      flush(buffer, normalized);
      node.children = normalized;
      if (node.children.length === 1 && node.children[0] === node.name)
        node.children = [];
    };
    visitNode(root);
  }

  function normalizeGenericRoles(root: AriaNode): void {
    const normalize = (node: AriaNode): Array<AriaNode | string> => {
      const children: Array<AriaNode | string> = [];
      for (const child of node.children) {
        if (typeof child === 'string') {
          children.push(child);
        } else {
          children.push(...normalize(child));
        }
      }
      const removeSelf = node.role === 'generic' && !node.name && children.length <= 1 && children.every(child => typeof child !== 'string' && Boolean(child.ref));
      if (removeSelf)
        return children;
      node.children = children;
      return [node];
    };
    normalize(root);
  }

  function renderTree(root: AriaNode): { text: string; refs: any[]; tree: any[] } {
    const lines: string[] = [];
    const refs: any[] = [];
    const renderedTree: any[] = [];
    const roots = root.role === 'fragment' ? root.children : [root];

    for (const child of roots) {
      if (typeof child === 'string') {
        const text = normalizeText(child);
        if (text)
          lines.push(`- text: ${yamlValue(text)}`);
      } else {
        const rendered = renderNode(child, 0, true);
        if (rendered)
          renderedTree.push(rendered);
      }
    }

    return { text: lines.join('\n'), refs, tree: renderedTree };

    function renderNode(node: AriaNode, depth: number, renderCursorPointer: boolean): any | null {
      const key = renderNodeKey(node, renderCursorPointer);
      const singleText = singleTextChild(node);
      const hasProps = Object.keys(node.props).length > 0;
      const children = node.children;

      if (!hasProps && singleText !== undefined)
        lines.push(`${indent(depth)}- ${key}: ${yamlValue(singleText)}`);
      else if (!hasProps && !children.length)
        lines.push(`${indent(depth)}- ${key}`);
      else {
        lines.push(`${indent(depth)}- ${key}:`);
        for (const [name, value] of Object.entries(node.props))
          lines.push(`${indent(depth + 1)}- /${name}: ${yamlValue(value)}`);
        const inPointerCursor = Boolean(node.ref && renderCursorPointer && node.box.cursor === 'pointer');
        for (const child of children) {
          if (typeof child === 'string') {
            const text = normalizeText(child);
            if (text)
              lines.push(`${indent(depth + 1)}- text: ${yamlValue(text)}`);
          } else {
            renderNode(child, depth + 1, renderCursorPointer && !inPointerCursor);
          }
        }
      }

      const publicNode = publicNodeFor(node, children, depth);
      if (node.ref)
        refs.push(refRecord(node));
      return publicNode;
    }
  }

  function renderNodeKey(node: AriaNode, renderCursorPointer: boolean): string {
    let key = node.role;
    if (node.name)
      key += ` ${JSON.stringify(node.name)}`;
    if (node.checked === 'mixed')
      key += ' [checked=mixed]';
    else if (node.checked === true)
      key += ' [checked]';
    if (node.disabled)
      key += ' [disabled]';
    if (node.expanded)
      key += ' [expanded]';
    if (node.active)
      key += ' [active]';
    if (node.level)
      key += ` [level=${node.level}]`;
    if (node.pressed === 'mixed')
      key += ' [pressed=mixed]';
    else if (node.pressed === true)
      key += ' [pressed]';
    if (node.selected)
      key += ' [selected]';
    if (node.ref) {
      key += ` [ref=${node.ref}]`;
      if (renderCursorPointer && node.box.cursor === 'pointer')
        key += ' [cursor=pointer]';
    }
    if (renderBoxes)
      key += ` [box=${node.box.x},${node.box.y},${node.box.width},${node.box.height}]`;
    return key;
  }

  function publicNodeFor(node: AriaNode, children: Array<AriaNode | string>, depth: number): any {
    const publicNode: any = {
      role: node.role,
      name: node.name || undefined,
      ref: node.ref || undefined,
      tag: node.tag,
      text: singleTextChild(node) || undefined,
      props: Object.keys(node.props).length ? node.props : undefined,
      state: stateFor(node),
      children: undefined
    };
    if (renderBoxes)
      publicNode.box = { x: node.box.x, y: node.box.y, width: node.box.width, height: node.box.height };

    const publicChildren: any[] = [];
    for (const child of children) {
      if (typeof child === 'string') {
        const text = normalizeText(child);
        if (text)
          publicChildren.push({ text });
      } else {
        publicChildren.push(publicNodeFor(child, child.children, depth + 1));
      }
    }
    if (publicChildren.length)
      publicNode.children = publicChildren;
    return compactObject(publicNode);
  }

  function refRecord(node: AriaNode): any {
    const element = node.element as any;
    const attributes = safeAttributes(element);
    const text = singleTextChild(node) || directTextOfElement(element) || nodeSearchText(node);
    const parsedRef = node.ref ? agentRefs.parse(node.ref) : null;
    return compactObject({
      ref: node.ref,
      id: node.ref,
      structureId: parsedRef?.structureId,
      revision: parsedRef?.revision,
      role: node.role,
      name: node.name || null,
      tag: node.tag,
      text: text || null,
      selector: cssSelector(element),
      testId: element?.getAttribute?.('data-testid') || element?.getAttribute?.('data-test-id') || null,
      href: element?.getAttribute?.('href') || null,
      box: { x: node.box.x, y: node.box.y, width: node.box.width, height: node.box.height },
      state: stateFor(node),
      attributes
    });
  }

  function stateFor(node: AriaNode): any {
    return compactObject({
      checked: node.checked,
      disabled: node.disabled || undefined,
      expanded: node.expanded,
      active: node.active || undefined,
      level: node.level,
      pressed: node.pressed,
      selected: node.selected || undefined
    });
  }

  function compactObject(value: any): any {
    for (const key of Object.keys(value)) {
      if (value[key] === undefined)
        delete value[key];
      else if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) && !Object.keys(value[key]).length)
        delete value[key];
    }
    return value;
  }

  function singleTextChild(node: AriaNode): string | undefined {
    return node.children.length === 1 && typeof node.children[0] === 'string' && !Object.keys(node.props).length ? normalizeText(node.children[0]) : undefined;
  }

  function nodeSearchText(node: AriaNode): string {
    const parts: string[] = [];
    if (node.name)
      parts.push(node.name);
    for (const child of node.children) {
      if (typeof child === 'string')
        parts.push(child);
      else
        parts.push(nodeSearchText(child));
    }
    return normalizeText(parts.join(' '), 1000);
  }

  function directTextOfElement(el: any): string {
    if (!el?.childNodes)
      return '';
    const parts: string[] = [];
    for (const child of Array.from(el.childNodes) as any[]) {
      if (child?.nodeType === Node.TEXT_NODE)
        parts.push(child.nodeValue ?? child.textContent ?? '');
    }
    return normalizeText(parts.join(' '), 300);
  }

  function safeAttributes(el: any): any {
    if (!el)
      return {};
    const tag = tagName(el);
    const supportsValue = tag === 'input' || tag === 'textarea';
    const rawValue = supportsValue ? String(el.value || '') : '';
    const sensitive = supportsValue && isSensitiveField(el);
    return compactObject({
      type: el.getAttribute?.('type') || null,
      value: supportsValue ? (sensitive ? (rawValue ? '[redacted]' : null) : rawValue.slice(0, 100) || null) : null,
      valueLength: supportsValue && rawValue ? rawValue.length : null,
      checked: typeof el.checked === 'boolean' ? el.checked : null,
      placeholder: el.getAttribute?.('placeholder') || null,
      redacted: sensitive || undefined
    });
  }

  function getAriaRole(el: Element): string {
    const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (explicit)
      return explicit;
    const tag = tagName(el);
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && hasAttr(el, 'href'))
      return 'link';
    if (tag === 'button')
      return 'button';
    if (tag === 'select')
      return hasAttr(el, 'multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea')
      return 'textbox';
    if (tag === 'input') {
      if (type === 'hidden')
        return 'none';
      if (type === 'checkbox')
        return 'checkbox';
      if (type === 'radio')
        return 'radio';
      if (['button', 'submit', 'reset', 'image'].includes(type))
        return 'button';
      if (type === 'range')
        return 'slider';
      if (type === 'number')
        return 'spinbutton';
      if (type === 'search')
        return 'searchbox';
      return 'textbox';
    }
    const roleMap: Record<string, string> = {
      article: 'article',
      aside: 'complementary',
      blockquote: 'blockquote',
      code: 'code',
      dialog: 'dialog',
      figure: 'figure',
      footer: 'contentinfo',
      form: 'form',
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      header: 'banner',
      iframe: 'iframe',
      img: 'img',
      li: 'listitem',
      main: 'main',
      nav: 'navigation',
      ol: 'list',
      p: 'paragraph',
      section: hasExplicitAccessibleName(el) ? 'region' : 'generic',
      table: 'table',
      tbody: 'rowgroup',
      td: 'cell',
      th: 'columnheader',
      tr: 'row',
      ul: 'list'
    };
    return roleMap[tag] || 'generic';
  }

  function getElementAccessibleName(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => textFromElement(el.ownerDocument.getElementById(id))).filter(Boolean).join(' ');
      if (text)
        return text;
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel)
      return ariaLabel;
    const tag = tagName(el);
    if (tag === 'img')
      return el.getAttribute('alt') || el.getAttribute('title') || '';
    if (tag === 'input') {
      const type = String(el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type))
        return (el as HTMLInputElement).value || el.getAttribute('title') || '';
      return associatedLabel(el) || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    }
    if (tag === 'textarea' || tag === 'select')
      return associatedLabel(el) || el.getAttribute('placeholder') || el.getAttribute('title') || '';
    const title = el.getAttribute('title');
    if (title)
      return title;
    if (['button', 'a', 'summary', 'option'].includes(tag) || el.getAttribute('role'))
      return textFromElement(el);
    return '';
  }

  function associatedLabel(el: Element): string {
    const id = el.getAttribute('id');
    if (id) {
      try {
        const label = el.ownerDocument.querySelector(`label[for="${cssEscape(id)}"]`);
        const text = textFromElement(label);
        if (text)
          return text;
      } catch {
      }
    }
    let current: Element | null = el.parentElement;
    while (current) {
      if (tagName(current) === 'label')
        return textFromElement(current);
      current = current.parentElement;
    }
    return '';
  }

  function textFromElement(el: Element | null): string {
    if (!el)
      return '';
    const tag = tagName(el);
    if (tag === 'input' || tag === 'textarea') {
      if (isSensitiveField(el))
        return el.getAttribute('placeholder') || '';
      return String((el as HTMLInputElement | HTMLTextAreaElement).value || el.getAttribute('placeholder') || '');
    }
    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      return select.options?.[select.selectedIndex]?.text || '';
    }
    if (tag === 'img')
      return el.getAttribute('alt') || '';
    return normalizeText((el as HTMLElement).innerText || el.textContent || '', 900);
  }

  function hasExplicitAccessibleName(el: Element): boolean {
    return Boolean(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'));
  }

  function getAriaChecked(el: Element): boolean | 'mixed' | undefined {
    const aria = getMixedBooleanAria(el, 'aria-checked');
    if (aria !== undefined)
      return aria;
    if (tagName(el) === 'input' && ['checkbox', 'radio'].includes(String(el.getAttribute('type') || '').toLowerCase()))
      return Boolean((el as HTMLInputElement).checked);
    return undefined;
  }

  function getAriaDisabled(el: Element): boolean {
    return (el as HTMLButtonElement).disabled === true || getBooleanAria(el, 'aria-disabled') === true;
  }

  function getAriaLevel(el: Element, role: string): number | undefined {
    const attr = Number(el.getAttribute('aria-level'));
    if (Number.isFinite(attr) && attr > 0)
      return attr;
    if (role === 'heading') {
      const match = /^h([1-6])$/.exec(tagName(el));
      if (match)
        return Number(match[1]);
    }
    return undefined;
  }

  function getBooleanAria(el: Element, name: string): boolean | undefined {
    const value = el.getAttribute(name);
    if (value === 'true')
      return true;
    if (value === 'false')
      return false;
    return undefined;
  }

  function getMixedBooleanAria(el: Element, name: string): boolean | 'mixed' | undefined {
    const value = el.getAttribute(name);
    if (value === 'mixed')
      return 'mixed';
    if (value === 'true')
      return true;
    if (value === 'false')
      return false;
    return undefined;
  }

  function isTextInput(el: Element): boolean {
    const tag = tagName(el);
    if (tag === 'textarea')
      return true;
    if (tag !== 'input')
      return false;
    const type = String(el.getAttribute('type') || 'text').toLowerCase();
    return !['checkbox', 'radio', 'file', 'hidden', 'button', 'submit', 'reset', 'image'].includes(type);
  }

  function isElementHiddenForAria(el: Element): boolean {
    if (isNeverRenderedTag(tagName(el)))
      return true;
    if (tagName(el) === 'input' && String(el.getAttribute('type') || '').toLowerCase() === 'hidden')
      return true;
    let current: Element | null = el;
    while (current) {
      if (current.getAttribute('aria-hidden') === 'true' || hasAttr(current, 'hidden'))
        return true;
      const style = getStyle(current);
      if (style.display === 'none')
        return true;
      current = current.parentElement;
    }
    return false;
  }

  function isElementVisible(el: Element): boolean {
    const style = getStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')
      return false;
    const rect = safeRect(el);
    return rect.width > 0 && rect.height > 0;
  }

  function receivesPointerEvents(el: Element, box: Box): boolean {
    if (!box.visible)
      return false;
    if (getStyle(el).pointerEvents === 'none')
      return false;
    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const x = Math.max(0, Math.min((win.innerWidth || window.innerWidth || 0) - 1, box.x + box.width / 2));
    const y = Math.max(0, Math.min((win.innerHeight || window.innerHeight || 0) - 1, box.y + box.height / 2));
    try {
      const hit = doc.elementFromPoint?.(x, y);
      return !hit || hit === el || el.contains(hit);
    } catch {
      return true;
    }
  }

  function computeBox(el: Element): Box {
    const rect = safeRect(el);
    const style = getStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    return {
      x: Math.round(rect.x ?? rect.left ?? 0),
      y: Math.round(rect.y ?? rect.top ?? 0),
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0),
      visible,
      inline: style.display === 'inline',
      cursor: style.cursor || ''
    };
  }

  function safeRect(el: Element): DOMRect {
    try {
      return el.getBoundingClientRect();
    } catch {
      return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    }
  }

  function getStyle(el: Element): CSSStyleDeclaration {
    try {
      return (el.ownerDocument?.defaultView || window).getComputedStyle(el);
    } catch {
      return { display: 'inline', visibility: 'visible', cursor: '', pointerEvents: 'auto' } as CSSStyleDeclaration;
    }
  }

  function isInViewport(box: Box): boolean {
    return box.y + box.height >= 0 && box.x + box.width >= 0 && box.y <= window.innerHeight && box.x <= window.innerWidth;
  }

  function isActiveElement(el: Element): boolean {
    if (el.ownerDocument?.activeElement === el)
      return true;
    if (tagName(el) === 'iframe') {
      try {
        return (el as HTMLIFrameElement).contentDocument?.activeElement !== (el as HTMLIFrameElement).contentDocument?.body;
      } catch {
        return false;
      }
    }
    return false;
  }

  function isSensitiveField(el: Element): boolean {
    const tag = tagName(el);
    if (tag !== 'input' && tag !== 'textarea')
      return false;
    const type = String(el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'hidden')
      return true;
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

  function cssSelector(el: any): string | null {
    if (!el?.tagName)
      return null;
    const tag = tagName(el);
    if (el.id)
      return `#${cssEscape(el.id)}`;
    const testId = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id');
    if (testId)
      return `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return cls.length ? `${tag}.${cls.map(cssEscape).join('.')}` : tag;
  }

  function cssEscape(value: string): string {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function tagName(el: Element): string {
    return String((el as any).tagName || '').toLowerCase();
  }

  function childNodesOf(node: any): Node[] {
    if (node?.childNodes && typeof node.childNodes[Symbol.iterator] === 'function')
      return Array.from(node.childNodes);
    const result: Node[] = [];
    for (let child = node?.firstChild; child; child = child.nextSibling)
      result.push(child);
    return result;
  }

  function hasAttr(el: Element, name: string): boolean {
    return typeof (el as any).hasAttribute === 'function'
      ? (el as any).hasAttribute(name)
      : el.getAttribute(name) !== null;
  }

  function isNeverRenderedTag(tag: string): boolean {
    return ['script', 'style', 'template', 'noscript', 'meta', 'link', 'title'].includes(tag);
  }

  function normalizeText(value: unknown, max = 10000): string {
    return String(value ?? '').replace(/[\u200b\u00ad]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function yamlValue(value: string): string {
    const text = normalizeText(value);
    if (!text)
      return '""';
    if (/^[A-Za-z0-9][A-Za-z0-9 .,;:!?()'/_+-]*$/.test(text) && !/^(true|false|null|undefined)$/i.test(text))
      return text;
    return JSON.stringify(text);
  }

  function indent(depth: number): string {
    return '  '.repeat(depth);
  }

  const root = generateTree(document.body || document.documentElement);
  const rendered = renderTree(root);
  const filters = {
    roles: options?.roles || null,
    tags: options?.tags || null,
    hasVisibleText,
    textIncludes: textIncludes || null,
    viewportOnly,
    boxes: renderBoxes || undefined
  };

  return {
    schemaVersion: 3,
    semantics: 'playwright-aria-ai-v1',
    snapshot: rendered.text,
    tree: rendered.tree,
    refs: rendered.refs,
    url: window.location.href,
    title: document.title,
    stats: {
      ...stats,
      returned: rendered.refs.length,
      truncated: stats.truncated
    },
    filters,
    guidance: {
      refFormat: '@e<structureId>_<revision>',
      refLifetime: 'valid until the referenced element changes or a new page state invalidates the revision',
      textReading: 'snapshot is optimized for structure and interaction targets; use get_text for long prose'
    }
  };

  function installAgentRefRuntime(): any {
    const rootWindow = window as any;
    if (rootWindow.__browserControlAgentRef?.version === 2)
      return rootWindow.__browserControlAgentRef;

    type RegistryEntry = {
      revision: number;
      fingerprint: string;
      id: string;
      label: string;
      lastSeenAt: number;
    };
    type Registry = { version: number; entries: Record<string, RegistryEntry> };

    const registry: Registry = rootWindow.__browserControlAgentRefRegistry?.version === 2
      ? rootWindow.__browserControlAgentRefRegistry
      : { version: 2, entries: {} };
    rootWindow.__browserControlAgentRefRegistry = registry;

    function normalize(value: unknown, max = 160): string {
      return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    function inferRoleForRef(el: any): string {
      const explicit = el.getAttribute?.('role') || el.getAttribute?.('aria-role');
      if (explicit)
        return String(explicit).trim().split(/\s+/)[0];
      const tag = String(el.tagName || '').toLowerCase();
      const type = String(el.getAttribute?.('type') || '').toLowerCase();
      if (tag === 'a' && el.hasAttribute?.('href')) return 'link';
      const roleMap: Record<string, string> = {
        button: 'button',
        select: 'combobox',
        textarea: 'textbox',
        img: 'img',
        iframe: 'iframe',
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
        tr: 'row',
        td: 'cell',
        th: 'columnheader',
        li: 'listitem',
        ul: 'list',
        ol: 'list',
        dialog: 'dialog'
      };
      if (tag === 'input') {
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        return 'textbox';
      }
      return roleMap[tag] || 'generic';
    }

    function textForRef(el: any): string {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea')
        return normalize(el.getAttribute?.('placeholder') || '', 120);
      if (tag === 'select')
        return normalize(el.options?.[el.selectedIndex]?.text || '', 120);
      if (tag === 'img')
        return normalize(el.getAttribute?.('alt') || el.alt || '', 120);
      return normalize(el.getAttribute?.('aria-label') || el.innerText || el.textContent || '', 160);
    }

    function accessibleNameForRef(el: any): string {
      return normalize(
        el.getAttribute?.('aria-label') ||
        el.getAttribute?.('title') ||
        el.getAttribute?.('alt') ||
        el.getAttribute?.('placeholder') ||
        '',
        160
      );
    }

    function stableAttr(el: any): string {
      const testId = el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id');
      if (testId) return `test=${normalize(testId, 80)}`;
      const id = el.getAttribute?.('id') || '';
      if (id && !/[0-9a-f]{8,}|react-select-\d+|ember\d+|^[:_\-a-z]*\d{4,}$/i.test(id))
        return `id=${normalize(id, 80)}`;
      const name = el.getAttribute?.('name') || '';
      if (name) return `name=${normalize(name, 80)}`;
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

    function urlScope(el: Element): string {
      try {
        const href = el.ownerDocument?.defaultView?.location?.href || window.location.href;
        const url = new URL(href);
        return `${url.origin}${url.pathname}`;
      } catch {
        return String(window.location.href || '').split('?')[0].split('#')[0];
      }
    }

    function structuralPath(el: Element): string {
      const parts: string[] = [];
      let current: Element | null = el;
      let depth = 0;
      while (current && current !== current.ownerDocument.documentElement && depth < 10) {
        parts.unshift(structuralSegment(current));
        if (current === current.ownerDocument.body) break;
        current = current.parentElement;
        depth += 1;
      }
      return `top|${urlScope(el)}|${parts.join('>')}`;
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
      const href = tag === 'a' ? normalize(el.getAttribute?.('href') || '', 200) : '';
      return [
        `tag=${tag}`,
        `role=${inferRoleForRef(el)}`,
        `name=${accessibleNameForRef(el)}`,
        `text=${textForRef(el)}`,
        `href=${href}`,
        `type=${normalize(el.getAttribute?.('type') || '', 40)}`,
        `test=${normalize(el.getAttribute?.('data-testid') || el.getAttribute?.('data-test-id') || '', 80)}`,
        `ariaChecked=${normalize(el.getAttribute?.('aria-checked') || '', 20)}`,
        `ariaSelected=${normalize(el.getAttribute?.('aria-selected') || '', 20)}`
      ].join('|');
    }

    function computeFingerprint(el: Element): string {
      return hashString(fingerprintSource(el));
    }

    function labelFor(el: any): string {
      const role = inferRoleForRef(el);
      const text = accessibleNameForRef(el) || textForRef(el);
      return normalize(`${role} ${text}`.trim(), 120);
    }

    function writeMetadata(el: any, structureId: string, revision: number, fingerprint: string, id: string, label: string): void {
      try {
        el.setAttribute('data-agent-id', id);
        el.setAttribute('data-agent-structure-id', structureId);
        el.setAttribute('data-agent-revision', String(revision));
        el.setAttribute('data-agent-fingerprint', fingerprint);
        el.setAttribute('data-agent-label', label);
      } catch {
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

    function allReachableElements(): Element[] {
      const result: Element[] = [];
      const scan = (doc: Document | null | undefined) => {
        if (!doc?.body)
          return;
        const elements = typeof (doc.body as any).querySelectorAll === 'function'
          ? Array.from(doc.body.querySelectorAll('*'))
          : typeof (doc as any).querySelectorAll === 'function'
            ? Array.from((doc as any).querySelectorAll('*'))
            : [];
        result.push(...(elements as Element[]));
        const frames = typeof (doc as any).querySelectorAll === 'function' ? Array.from((doc as any).querySelectorAll('iframe')) : [];
        for (const frame of frames) {
          try {
            scan((frame as HTMLIFrameElement).contentDocument);
          } catch {
          }
        }
      };
      scan(document);
      return result.slice(0, 10000);
    }

    function findByAttribute(name: string, value: string): Element | null {
      for (const el of allReachableElements()) {
        if (el.getAttribute(name) === value)
          return el;
      }
      return null;
    }

    function describe(el: Element | null): any {
      if (!el || !el.tagName) return null;
      return {
        id: el.getAttribute('data-agent-id') || null,
        tag: el.tagName.toLowerCase(),
        role: inferRoleForRef(el),
        label: labelFor(el),
        text: textForRef(el)
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
      const marked = findByAttribute('data-agent-structure-id', structureId);
      if (marked) return marked;
      for (const el of allReachableElements()) {
        try {
          if (computeStructureId(el) === structureId) return el;
        } catch {
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

      const exact = findByAttribute('data-agent-id', ref);
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
      if (storedStructureId !== parsed.structureId || currentStructureId !== parsed.structureId)
        return stale(ref, parsed, exact, 'element structural location changed');
      if (storedRevision !== parsed.revision || (entry && entry.revision !== parsed.revision))
        return stale(ref, parsed, exact, 'reference revision changed');
      if (storedFingerprint && currentFingerprint !== storedFingerprint)
        return stale(ref, parsed, exact, 'element fingerprint changed');
      return { element: exact, id: ref, structureId: parsed.structureId, revision: parsed.revision };
    }

    rootWindow.__browserControlAgentRef = {
      version: 2,
      assign,
      resolve,
      computeStructureId,
      computeFingerprint,
      parse
    };
    return rootWindow.__browserControlAgentRef;
  }
}
