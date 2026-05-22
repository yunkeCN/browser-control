type FileInputElement = any;

export function performUpload(selector: string, files: unknown): any {
  function localFindElement(sel: string): FileInputElement | null {
    // Support @e references (accessibility tree IDs)
    if (sel.startsWith('@e')) {
      // @e references point to elements by their position in the snapshot
      // We need to rebuild the tree to find them — for now use a marker approach
      // This is handled by tagging elements during snapshot
      // Fallback: try to find by data-agent-id
      return document.querySelector(`[data-agent-id="${sel}"]`) as FileInputElement | null;
    }

    // CSS selector
    try {
      return document.querySelector(sel) as FileInputElement | null;
    } catch {
      return null;
    }
  }

  const el = localFindElement(selector);
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
