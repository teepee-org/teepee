import { useState, useCallback, useRef } from 'react';

export type FileSource = 'fs' | 'tp';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  source: FileSource;
  insertText?: string;
  canonicalUri?: string;
}

export type SourceFilter = 'all' | 'fs' | 'tp';

interface FileSelectorState {
  isOpen: boolean;
  entries: FileEntry[];
  loading: boolean;
  activeIndex: number;
  triggerIndex: number;
  sourceFilter: SourceFilter;
}

const API_BASE = '/api';

/**
 * Parse a pipe-trigger token to extract source filter, directory, and query.
 *
 * Syntax:
 *   |path        → source=all (unified)
 *   fs|path      → source=fs  (filesystem only)
 *   tp|path      → source=tp  (topic/artifact only)
 *   | (space)    → escape: return null to close selector
 */
export function parseToken(token: string): {
  source: SourceFilter;
  dir: string;
  query: string;
  prefix: string;
} | null {
  let source: SourceFilter = 'all';
  let prefix: string;
  let rest: string;

  if (token.startsWith('fs|')) {
    source = 'fs';
    prefix = 'fs|';
    rest = token.slice(3);
  } else if (token.startsWith('tp|')) {
    source = 'tp';
    prefix = 'tp|';
    rest = token.slice(3);
  } else if (token.startsWith('|')) {
    prefix = '|';
    rest = token.slice(1);
  } else {
    return null;
  }

  // Space right after pipe = escape
  if (rest.startsWith(' ')) {
    return null;
  }

  if (rest === '') {
    return { source, dir: '', query: '', prefix };
  }

  if (rest.endsWith('/')) {
    return { source, dir: rest, query: '', prefix };
  }

  const lastSlash = rest.lastIndexOf('/');
  if (lastSlash === -1) {
    return { source, dir: '', query: rest, prefix };
  }

  return {
    source,
    dir: rest.slice(0, lastSlash + 1),
    query: rest.slice(lastSlash + 1),
    prefix,
  };
}

/**
 * Find the pipe-trigger token around the cursor.
 * Walks backwards from cursor to find '|', then checks for optional 'fs' or 'tp' prefix.
 * The character before the prefix must be a word boundary (space, newline, tab, or start).
 */
export function getPipeToken(
  value: string,
  cursorPos: number
): { start: number; token: string } | null {
  let i = cursorPos - 1;

  while (i >= 0) {
    const ch = value[i];
    if (ch === '|') {
      let start = i;

      // Check for "fs|" or "tp|" prefix
      if (i >= 2 && value[i - 2] === 'f' && value[i - 1] === 's') {
        const beforePrefix = i - 3;
        if (
          beforePrefix < 0 ||
          value[beforePrefix] === ' ' ||
          value[beforePrefix] === '\n' ||
          value[beforePrefix] === '\t'
        ) {
          start = i - 2;
        }
      } else if (i >= 2 && value[i - 2] === 't' && value[i - 1] === 'p') {
        const beforePrefix = i - 3;
        if (
          beforePrefix < 0 ||
          value[beforePrefix] === ' ' ||
          value[beforePrefix] === '\n' ||
          value[beforePrefix] === '\t'
        ) {
          start = i - 2;
        }
      } else {
        // Bare | — check word boundary before it
        const beforePipe = i - 1;
        if (
          beforePipe < 0 ||
          value[beforePipe] === ' ' ||
          value[beforePipe] === '\n' ||
          value[beforePipe] === '\t'
        ) {
          // ok
        } else {
          return null; // | in the middle of a word
        }
      }

      const token = value.slice(start, cursorPos);
      return { start, token };
    }

    // Stop at whitespace before finding |
    if (ch === ' ' || ch === '\n' || ch === '\t') return null;
    i--;
  }
  return null;
}

export function useFileSelector() {
  const [state, setState] = useState<FileSelectorState>({
    isOpen: false,
    entries: [],
    loading: false,
    activeIndex: 0,
    triggerIndex: -1,
    sourceFilter: 'all',
  });

  const abortRef = useRef<AbortController | null>(null);

  const fetchEntries = useCallback(
    async (source: SourceFilter, dir: string, query: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState((s) => ({ ...s, loading: true }));

      try {
        const params = new URLSearchParams();
        params.set('source', source);
        if (dir) params.set('path', dir);
        if (query) params.set('query', query);

        const res = await fetch(`${API_BASE}/files?${params}`, {
          signal: controller.signal,
        });
        const data = await res.json();

        if (!controller.signal.aborted) {
          setState((s) => ({
            ...s,
            entries: data.entries || [],
            loading: false,
            activeIndex: 0,
            sourceFilter: source,
          }));
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          setState((s) => ({ ...s, entries: [], loading: false }));
        }
      }
    },
    []
  );

  const open = useCallback(
    (triggerIndex: number, token: string) => {
      const parsed = parseToken(token);
      if (!parsed) return false;
      setState((s) => ({ ...s, isOpen: true, triggerIndex }));
      fetchEntries(parsed.source, parsed.dir, parsed.query);
      return true;
    },
    [fetchEntries]
  );

  const close = useCallback(() => {
    abortRef.current?.abort();
    setState({
      isOpen: false,
      entries: [],
      loading: false,
      activeIndex: 0,
      triggerIndex: -1,
      sourceFilter: 'all',
    });
  }, []);

  const updateQuery = useCallback(
    (token: string): boolean => {
      const parsed = parseToken(token);
      if (!parsed) return false;
      fetchEntries(parsed.source, parsed.dir, parsed.query);
      return true;
    },
    [fetchEntries]
  );

  const moveSelection = useCallback((delta: number) => {
    setState((s) => {
      const len = s.entries.length;
      if (len === 0) return s;
      const next = (s.activeIndex + delta + len) % len;
      return { ...s, activeIndex: next };
    });
  }, []);

  const getSelected = useCallback((): FileEntry | null => {
    return state.entries[state.activeIndex] ?? null;
  }, [state.entries, state.activeIndex]);

  return {
    ...state,
    open,
    close,
    updateQuery,
    moveSelection,
    getSelected,
  };
}
