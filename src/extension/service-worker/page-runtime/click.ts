type ClickElement = any;

export function performClick(selector: string, options: any = {}): any {
  function localFindElement(sel: string | null | undefined): { element: ClickElement | null; error?: any } | null {
    if (!sel) return null;
    try {
        if (String(sel).startsWith('@e')) {
          const runtime = (window as any).__browserControlAgentRef;
          if (!runtime?.resolve) {
            return {
              element: null,
              error: {
                error: `Agent reference runtime is unavailable for ${sel}. Take a fresh snapshot.`,
                code: 'STALE_ELEMENT_REFERENCE',
                recoverable: true,
                retryable: true,
                selector: sel,
                nextStep: 'Take a fresh snapshot and retry with the new @e reference.'
              }
            };
          }
          const resolved = runtime.resolve(String(sel));
          if (resolved?.error) return { element: null, error: resolved };
          return { element: resolved.element as ClickElement };
        }
        return { element: document.querySelector(sel) as ClickElement | null };
    } catch {
      return { element: null };
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

  function localOwnerDocument(el: Element): Document {
    return el.ownerDocument || document;
  }

  function localOwnerWindow(el: Element): Window {
    return localOwnerDocument(el).defaultView || window;
  }

  function localFramePath(ownerWindow: Window, frameClientX: number, frameClientY: number): any {
    let topClientX = frameClientX;
    let topClientY = frameClientY;
    const frames: any[] = [];
    let currentWindow: any = ownerWindow;

    while (currentWindow && currentWindow !== window) {
      let frameElement: Element | null = null;
      try {
        frameElement = currentWindow.frameElement as Element | null;
      } catch {
        frameElement = null;
      }
      if (!frameElement)
        break;

      const rect = frameElement.getBoundingClientRect();
      const clientLeft = Number((frameElement as HTMLElement).clientLeft || 0);
      const clientTop = Number((frameElement as HTMLElement).clientTop || 0);
      topClientX += rect.left + clientLeft;
      topClientY += rect.top + clientTop;
      frames.push({ element: frameElement, rect, clientLeft, clientTop });

      try {
        if (!currentWindow.parent || currentWindow.parent === currentWindow)
          break;
        currentWindow = currentWindow.parent;
      } catch {
        break;
      }
    }

    return {
      frames,
      frameDepth: frames.length,
      topFrameElement: frames.length ? frames[frames.length - 1].element : null,
      topClientX: Math.round(topClientX),
      topClientY: Math.round(topClientY)
    };
  }

  function localFramePathSummary(frames: any[]): any[] {
    return frames.map((frame, index) => ({
      index,
      element: localDescribeElement(frame.element),
      rect: frame.rect ? {
        x: Math.round(frame.rect.left),
        y: Math.round(frame.rect.top),
        width: Math.round(frame.rect.width),
        height: Math.round(frame.rect.height)
      } : null
    }));
  }

  function localClickGeometry(el: Element): any {
    const ownerDocument = localOwnerDocument(el);
    const ownerWindow = localOwnerWindow(el);
    const rect = el.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0)
      return { error: `Element is not clickable because it has no visible box: ${selector}` };

    const frameClientX = Math.round(rect.left + rect.width / 2);
    const frameClientY = Math.round(rect.top + rect.height / 2);
    const framePath = localFramePath(ownerWindow, frameClientX, frameClientY);
    const frameHit = ownerDocument.elementFromPoint?.(frameClientX, frameClientY) || el;
    const frameHitWithinTarget = frameHit === el || Boolean(el.contains?.(frameHit));
    const topHit = framePath.frameDepth
      ? document.elementFromPoint?.(framePath.topClientX, framePath.topClientY) || framePath.topFrameElement
      : frameHit;
    const topHitWithinTarget = framePath.frameDepth
      ? Boolean(framePath.topFrameElement && (topHit === framePath.topFrameElement || framePath.topFrameElement.contains?.(topHit)))
      : frameHitWithinTarget;
    const hitWithinTarget = frameHitWithinTarget && topHitWithinTarget;
    const coveredBy = !frameHitWithinTarget ? frameHit : !topHitWithinTarget ? topHit : null;

    return {
      ownerDocument,
      ownerWindow,
      frameClientX,
      frameClientY,
      topClientX: framePath.topClientX,
      topClientY: framePath.topClientY,
      frameDepth: framePath.frameDepth,
      framePath: localFramePathSummary(framePath.frames),
      frameHit,
      topHit,
      frameHitWithinTarget,
      topHitWithinTarget,
      hitWithinTarget,
      coveredBy,
      hitTest: {
        clientX: framePath.topClientX,
        clientY: framePath.topClientY,
        frameClientX,
        frameClientY,
        topClientX: framePath.topClientX,
        topClientY: framePath.topClientY,
        frameDepth: framePath.frameDepth,
        hitWithinTarget,
        frameHitWithinTarget,
        topHitWithinTarget,
        hit: localDescribeElement(frameHit),
        topHit: framePath.frameDepth ? localDescribeElement(topHit) : null,
        coveredBy: hitWithinTarget ? null : localDescribeElement(coveredBy)
      }
    };
  }

  function localElementClick() {
    const found = localFindElement(selector);
    if (found?.error) return found.error;
    const el = found?.element;
    if (!el) return { error: `Element not found: ${selector}` };
    if (typeof el.click !== 'function') return { error: `Element cannot be clicked directly: ${selector}` };
    const ownerDocument = localOwnerDocument(el);
    const focusBefore = localDescribeElement(ownerDocument.activeElement);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    el.click();
    return {
      clicked: true,
      selector,
      strategyUsed: 'element_click',
      synthetic: true,
      target: localDescribeElement(el),
      focusBefore,
      focusAfter: localDescribeElement(ownerDocument.activeElement),
      warnings: ['element_click calls el.click() directly and may bypass pointer/mouse semantics and overlay hit-testing.']
    };
  }

  function localDomPointerClick() {
    const found = localFindElement(selector);
    if (found?.error) return found.error;
    const el = found?.element;
    if (!el) return { error: `Element not found: ${selector}` };
    const warnings = [...(Array.isArray(options?.warnings) ? options.warnings : [])];
    const ownerDocument = localOwnerDocument(el);
    const ownerWindow = localOwnerWindow(el);
    const focusBefore = localDescribeElement(ownerDocument.activeElement);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const geometry = localClickGeometry(el);
    if (geometry.error) return { error: geometry.error };
    if (!geometry.hitWithinTarget && options?.force !== true) {
      return {
        error: `Element is covered at click point: ${selector}`,
        code: 'COVERED_TARGET',
        recoverable: true,
        selector,
        strategyUsed: options?.strategyUsed || 'dom_pointer',
        target: localDescribeElement(el),
        hitTest: geometry.hitTest,
        warnings: ['Target center is covered. Use a fresh snapshot, close the overlay, choose a visible child target, or retry with force:true only after confirming intent.']
      };
    }
    if (!geometry.hitWithinTarget) warnings.push('force:true bypassed covered-element hit-test; dispatched events to the requested element.');
    const dispatchTarget = geometry.frameHitWithinTarget ? geometry.frameHit : el;
    const button = localMouseButton(options?.button);
    const clickCount = Math.max(1, Number(options?.clickCount || 1));
    const MouseCtor = (ownerWindow as any).MouseEvent || MouseEvent;
    const PointerCtor = (ownerWindow as any).PointerEvent || (typeof PointerEvent === 'function' ? PointerEvent : MouseCtor);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: ownerWindow,
      clientX: geometry.frameClientX,
      clientY: geometry.frameClientY,
      screenX: Math.round((window.screenX || 0) + geometry.topClientX),
      screenY: Math.round((window.screenY || 0) + geometry.topClientY),
      button,
      buttons: button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : 1,
      ...localModifiers(options?.modifiers)
    };
    const hoverBase = { ...base, buttons: 0, detail: 0 };
    const pointerHoverBase = { ...hoverBase, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0 };
    for (const [type, Ctor, init] of [
      ['pointerover', PointerCtor, pointerHoverBase],
      ['pointerenter', PointerCtor, { ...pointerHoverBase, bubbles: false }],
      ['mouseover', MouseCtor, hoverBase],
      ['mouseenter', MouseCtor, { ...hoverBase, bubbles: false }],
      ['pointermove', PointerCtor, pointerHoverBase],
      ['mousemove', MouseCtor, hoverBase]
    ] as Array<[string, typeof MouseEvent, MouseEventInit]>) {
      dispatchTarget.dispatchEvent(new (Ctor as typeof MouseEvent)(type, init as MouseEventInit));
    }
    for (let detail = 1; detail <= clickCount; detail += 1) {
      const downBase = { ...base, detail };
      const pointerDownBase = { ...downBase, pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0.5 };
      for (const [type, Ctor, init] of [
        ['pointerdown', PointerCtor, pointerDownBase],
        ['mousedown', MouseCtor, downBase],
        ['pointerup', PointerCtor, { ...pointerDownBase, buttons: 0, pressure: 0 }],
        ['mouseup', MouseCtor, { ...downBase, buttons: 0 }],
        ['click', MouseCtor, { ...downBase, buttons: 0 }]
      ] as Array<[string, typeof MouseEvent, MouseEventInit]>) {
        if (type === 'pointerup' && detail === 1 && typeof el.focus === 'function') el.focus({ preventScroll: true });
        dispatchTarget.dispatchEvent(new (Ctor as typeof MouseEvent)(type, init as MouseEventInit));
      }
    }
    if (clickCount >= 2)
      dispatchTarget.dispatchEvent(new (MouseCtor as typeof MouseEvent)('dblclick', { ...base, buttons: 0, detail: 2 } as MouseEventInit));
    return {
      clicked: true,
      selector,
      strategyUsed: options?.strategyUsed || 'dom_pointer',
      synthetic: true,
      target: localDescribeElement(el),
      dispatchedTo: localDescribeElement(dispatchTarget),
      hitTest: geometry.hitTest,
      frameDepth: geometry.frameDepth,
      framePath: geometry.framePath,
      focusBefore,
      focusAfter: localDescribeElement(ownerDocument.activeElement),
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
