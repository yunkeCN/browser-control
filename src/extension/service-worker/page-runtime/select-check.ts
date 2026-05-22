type MutableFormElement = any;

export function performSelectOption(selector: string, value: unknown): any {
  function localFindElement(sel: string): MutableFormElement | null {
    if (!sel) return null;
    try {
      if (String(sel).startsWith('@e')) return document.querySelector(`[data-agent-id="${sel}"]`) as MutableFormElement | null;
      return document.querySelector(sel) as MutableFormElement | null;
    } catch {
      return null;
    }
  }
  const el = localFindElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  if (el.tagName.toLowerCase() !== 'select') return { error: `Element is not a select: ${selector}` };
  const values = Array.isArray(value) ? value.map(String) : [String(value)];
  let matched = 0;
  for (const option of el.options) {
    const selected = values.includes(option.value) || values.includes(option.text);
    option.selected = el.multiple ? selected : selected && matched === 0;
    if (selected) matched += 1;
  }
  if (matched === 0) return { error: `No option matched: ${values.join(', ')}` };
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { selected: true, selector, value: Array.from((el as HTMLSelectElement).selectedOptions).map(o => o.value) };
}

export function performSetChecked(selector: string, checked: boolean): any {
  function localFindElement(sel: string): MutableFormElement | null {
    if (!sel) return null;
    try {
      if (String(sel).startsWith('@e')) return document.querySelector(`[data-agent-id="${sel}"]`) as MutableFormElement | null;
      return document.querySelector(sel) as MutableFormElement | null;
    } catch {
      return null;
    }
  }
  const el = localFindElement(selector);
  if (!el) return { error: `Element not found: ${selector}` };
  if (!['checkbox', 'radio'].includes((el.type || '').toLowerCase())) return { error: `Element is not checkable: ${selector}` };
  if (el.checked !== checked) {
    el.click();
    if (el.checked !== checked) el.checked = checked;
  }
  el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  return { checked: el.checked, selector };
}
