export function performEvaluate(code: unknown): any {
  interface SerializeState {
    warnings: string[];
    truncated: boolean;
    seen: WeakSet<object> | null;
  }

  function runEvaluationSource(source: string): any {
    try {
      // Expression-first mode preserves snippets such as document.title
      // and IIFEs that contain their own return statements.
      return eval('(async () => (' + source + '))()');
    } catch (expressionError) {
      if (!(expressionError instanceof SyntaxError) && (expressionError as any)?.name !== 'SyntaxError') throw expressionError;
      // Fall back to function-body mode only when the expression wrapper cannot parse,
      // for snippets such as "return { ok: true }" or multi-statement bodies.
    }
    return eval('(async () => { ' + source + ' })()');
  }

  function serializeEvaluationError(error: any): any {
    return {
      error: error?.message || String(error),
      errorDetails: {
        name: error?.name || 'Error',
        message: error?.message || String(error),
        stack: typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined
      }
    };
  }

  function serializeEvaluationPayload(value: any): any {
    const state: SerializeState = { warnings: [], truncated: false, seen: typeof WeakSet !== 'undefined' ? new WeakSet<object>() : null };
    const result = serializeEvaluationValue(value, state, 0);
    const payload: any = { result };
    if (value === undefined) {
      payload.result = null;
      payload.serialization = { undefinedResult: true, warnings: ['Evaluation returned undefined; use return ... or a single expression to return data.'] };
      return payload;
    }
    if (state.warnings.length || state.truncated) {
      payload.serialization = { truncated: state.truncated, warnings: state.warnings };
    }
    return payload;
  }

  function serializeEvaluationValue(value: any, state: SerializeState, depth: number): any {
    if (value === null) return null;
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') return value;
    if (type === 'undefined') return null;
    if (type === 'bigint') {
      state.warnings.push('Converted bigint to string.');
      return value.toString();
    }
    if (type === 'symbol' || type === 'function') {
      state.warnings.push('Converted ' + type + ' to string.');
      return String(value);
    }
    if (depth >= 6) {
      state.truncated = true;
      return '[MaxDepth]';
    }
    if (state.seen && typeof value === 'object') {
      if (state.seen.has(value)) {
        state.warnings.push('Replaced circular reference.');
        return '[Circular]';
      }
      state.seen.add(value);
    }
    if (typeof Element !== 'undefined' && value instanceof Element) {
      const rect = value.getBoundingClientRect();
      return {
        nodeType: 'element',
        tagName: value.tagName.toLowerCase(),
        id: value.id || null,
        className: typeof value.className === 'string' ? value.className : null,
        textContent: ((value as HTMLElement).innerText || value.textContent || '').slice(0, 500),
        boundingBox: {
          x: Math.round(rect.x + window.scrollX),
          y: Math.round(rect.y + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    }
    if (typeof Node !== 'undefined' && value instanceof Node) {
      return { nodeType: value.nodeType, nodeName: value.nodeName, textContent: (value.textContent || '').slice(0, 500) };
    }
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: typeof value.stack === 'string' ? value.stack.split('\n').slice(0, 8).join('\n') : undefined };
    }
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
      if (value.length > 100) state.truncated = true;
      return value.slice(0, 100).map(item => serializeEvaluationValue(item, state, depth + 1));
    }
    const output: any = {};
    const keys = Object.keys(value);
    if (keys.length > 100) state.truncated = true;
    for (const key of keys.slice(0, 100)) {
      try {
        output[key] = serializeEvaluationValue(value[key], state, depth + 1);
      } catch (err: any) {
        output[key] = '[Unserializable: ' + (err?.message || err) + ']';
        state.warnings.push('Could not serialize property ' + key + '.');
      }
    }
    return output;
  }

  const source = String(code ?? '');
  try {
    const result = runEvaluationSource(source);
    return Promise.resolve(result)
      .then(r => serializeEvaluationPayload(r))
      .catch(e => serializeEvaluationError(e));
  } catch (e) {
    return serializeEvaluationError(e);
  }
}
