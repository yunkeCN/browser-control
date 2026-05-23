export interface ScrollOptions {
  selector?: string;
  strategy?: 'auto' | 'dom' | 'wheel';
  /** @deprecated Mode is inferred from selector/x/y/delta arguments; kept as a compatibility override. */
  mode?: 'by' | 'to' | 'element';
  deltaX?: number;
  deltaY?: number;
  x?: number;
  y?: number;
  region?: { x: number; y: number; width: number; height: number };
  steps?: number;
  block?: ScrollLogicalPosition;
  behavior?: ScrollBehavior;
  waitMs?: number;
  warnings?: string[];
}

interface ScrollMetrics {
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

function numeric(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampStepCount(value: unknown): number {
  const n = Math.floor(numeric(value, 1));
  return Math.max(1, Math.min(n, 20));
}

function metricsFor(target: Element | Window): ScrollMetrics {
  if (target === window) {
    const root = document.scrollingElement || document.documentElement;
    return {
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollWidth: Math.round(root?.scrollWidth || document.documentElement.scrollWidth || 0),
      scrollHeight: Math.round(root?.scrollHeight || document.documentElement.scrollHeight || 0),
      clientWidth: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
      clientHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0)
    };
  }
  const el = target as Element;
  return {
    scrollX: Math.round((el as HTMLElement).scrollLeft || 0),
    scrollY: Math.round((el as HTMLElement).scrollTop || 0),
    scrollWidth: Math.round((el as HTMLElement).scrollWidth || 0),
    scrollHeight: Math.round((el as HTMLElement).scrollHeight || 0),
    clientWidth: Math.round((el as HTMLElement).clientWidth || 0),
    clientHeight: Math.round((el as HTMLElement).clientHeight || 0)
  };
}

function isScrollable(el: Element): boolean {
  const style = window.getComputedStyle(el);
  const overflowY = `${style.overflowY} ${style.overflow}`;
  const overflowX = `${style.overflowX} ${style.overflow}`;
  const canY = /(auto|scroll|overlay)/.test(overflowY) && (el as HTMLElement).scrollHeight > (el as HTMLElement).clientHeight + 1;
  const canX = /(auto|scroll|overlay)/.test(overflowX) && (el as HTMLElement).scrollWidth > (el as HTMLElement).clientWidth + 1;
  return canY || canX;
}

function findScrollContainer(el: Element | null): Element | Window {
  let current: Element | null = el;
  while (current && current !== document.documentElement && current !== document.body) {
    if (isScrollable(current)) return current;
    current = current.parentElement;
  }
  return window;
}

function selectedTarget(selector?: string, mode?: string): { target: Element | Window; targetKind: 'document' | 'element'; element?: Element; error?: string; recoverable?: boolean } {
  if (!selector) return { target: window, targetKind: 'document' };
  const element = document.querySelector(selector);
  if (!element) return { target: window, targetKind: 'document', error: `Element not found for scroll selector: ${selector}`, recoverable: true };
  if (mode === 'element') return { target: window, targetKind: 'element', element };
  const target = findScrollContainer(element);
  return { target, targetKind: target === window ? 'document' : 'element', element };
}

function canMove(metrics: ScrollMetrics, dx: number, dy: number): boolean {
  const maxX = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const maxY = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  if (dx < 0 && metrics.scrollX > 0) return true;
  if (dx > 0 && metrics.scrollX < maxX) return true;
  if (dy < 0 && metrics.scrollY > 0) return true;
  if (dy > 0 && metrics.scrollY < maxY) return true;
  return false;
}

function inferScrollMode(options: ScrollOptions, hasDelta: boolean): 'by' | 'to' | 'element' {
  if (options.mode === 'by' || options.mode === 'to' || options.mode === 'element') return options.mode;
  if (options.x !== undefined || options.y !== undefined) return 'to';
  if (hasDelta) return 'by';
  if (options.selector) return 'element';
  return 'by';
}

export async function performDomScroll(options: ScrollOptions = {}): Promise<any> {
  const warnings = [...(options.warnings || [])];
  const deltaX = numeric(options.deltaX, 0);
  const deltaY = numeric(options.deltaY, 0);
  const hasDelta = deltaX !== 0 || deltaY !== 0;
  const mode = inferScrollMode(options, hasDelta);
  const resolved = selectedTarget(options.selector, mode);
  if (resolved.error) return { ok: false, error: resolved.error, recoverable: resolved.recoverable, warnings };

  const target = resolved.target;
  const targetKind = resolved.targetKind;
  const before = metricsFor(target);
  const steps = clampStepCount(options.steps);
  const behavior = options.behavior || 'instant';

  if (mode === 'element') {
    if (!resolved.element) return { ok: false, error: 'selector is required for scroll mode element', recoverable: true, warnings };
    const elBefore = resolved.element.getBoundingClientRect();
    resolved.element.scrollIntoView({ block: options.block || 'center', inline: 'nearest', behavior });
    const waitMs = Math.max(0, Math.min(numeric(options.waitMs, 0), 5000));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    const elAfter = resolved.element.getBoundingClientRect();
    const after = metricsFor(target);
    const movedX = Math.round(elAfter.x - elBefore.x);
    const movedY = Math.round(elAfter.y - elBefore.y);
    const ok = movedX !== 0 || movedY !== 0;
    if (!ok && warnings.length === 0) warnings.push('Scroll completed but target position did not change.');
    return {
      ok,
      target: targetKind,
      strategyUsed: 'dom',
      before,
      after,
      movedX,
      movedY,
      atBoundary: false,
      warnings: warnings.length ? warnings : undefined
    };
  } else if (mode === 'to') {
    const x = numeric(options.x, before.scrollX);
    const y = numeric(options.y, before.scrollY);
    if (target === window) window.scrollTo({ left: x, top: y, behavior });
    else (target as Element).scrollTo({ left: x, top: y, behavior });
  } else {
    if (!canMove(before, deltaX, deltaY)) warnings.push('Scroll target is already at the requested boundary or is not scrollable in that direction.');
    for (let i = 0; i < steps; i += 1) {
      const left = deltaX / steps;
      const top = deltaY / steps;
      if (target === window) window.scrollBy({ left, top, behavior });
      else (target as Element).scrollBy({ left, top, behavior });
    }
  }

  const waitMs = Math.max(0, Math.min(numeric(options.waitMs, 0), 5000));
  if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
  const after = metricsFor(target);
  const movedX = after.scrollX - before.scrollX;
  const movedY = after.scrollY - before.scrollY;
  const atBoundary = !canMove(after, deltaX || movedX, deltaY || movedY);
  const ok = movedX !== 0 || movedY !== 0;
  if (!ok && warnings.length === 0) warnings.push('Scroll completed but target position did not change.');

  return {
    ok,
    target: targetKind,
    strategyUsed: 'dom',
    before,
    after,
    movedX,
    movedY,
    atBoundary,
    warnings: warnings.length ? warnings : undefined
  };
}
