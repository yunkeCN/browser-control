type FileInputElement = any;

export function performUpload(selector: string, files: unknown): any {
  function localFindElement(sel: string): { element: FileInputElement | null; error?: any } | null {
    if (sel.startsWith('@e')) {
      const runtime = (window as any).__browserControlAgentRef;
      if (!runtime?.resolve) return { element: null, error: { error: `Agent reference runtime is unavailable for ${sel}. Take a fresh snapshot.`, code: 'STALE_ELEMENT_REFERENCE', recoverable: true, retryable: true, selector: sel, nextStep: 'Take a fresh snapshot and retry with the new @e reference.' } };
      const resolved = runtime.resolve(String(sel));
      if (resolved?.error) return { element: null, error: resolved };
      return { element: resolved.element as FileInputElement };
    }

    // CSS selector
    try {
      return { element: document.querySelector(sel) as FileInputElement | null };
    } catch {
      return null;
    }
  }

  const found = localFindElement(selector);
  if (found?.error) return found.error;
  const el = found?.element;
  if (!el) return { error: `Element not found: ${selector}` };
  if (el.tagName.toLowerCase() !== 'input' || el.type !== 'file') {
    return { error: 'Element is not a file input' };
  }

  // File upload requires native file picker which content scripts can't do.
  // We signal the service worker to handle this.
  return {
    status: 'needs_native_picker',
    selector,
    accept: el.accept || null,
    multiple: el.multiple || false,
    files
  };
}
