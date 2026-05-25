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

  const found = localFindElement(selector);
  if (found?.error) return found.error;
  const el = found?.element;
  if (!el) return { error: `Element not found: ${selector}`, recoverable: true, strategyUsed: 'cdp_mouse' };

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { error: `Element is not clickable because it has no visible box: ${selector}`, recoverable: true, strategyUsed: 'cdp_mouse' };
  }

  const ownerDocument = localOwnerDocument(el);
  const ownerWindow = localOwnerWindow(el);
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
  const hitTest = {
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
      warnings: ['Target center is covered. Use a fresh snapshot, close the overlay, or choose a visible child target.']
    };
  }

  return {
    selector,
    strategyUsed: 'cdp_mouse',
    target: localDescribeElement(el),
    hitTest,
    frameDepth: framePath.frameDepth,
    framePath: localFramePathSummary(framePath.frames),
    warnings: hitWithinTarget ? [] : ['force:true bypassed covered-element hit-test for cdp_mouse.']
  };
}
