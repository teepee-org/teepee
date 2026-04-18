import { useCallback, useEffect, useState } from 'react';
import {
  fetchFsRoots,
  fetchFsEntries,
  type FilesystemRootInfo,
  type FsDirEntry,
} from '../api';

export interface FsTreeNode {
  rootId: string;
  rootKind: 'workspace' | 'host';
  path: string; // relative to root; '' for root itself
  name: string;
  type: 'root' | 'directory' | 'file';
}

export interface FsTreeState {
  roots: FilesystemRootInfo[];
  rootsLoading: boolean;
  rootsError: string | null;
  childrenByKey: Record<string, FsDirEntry[] | undefined>;
  loadingKeys: Set<string>;
  errorByKey: Record<string, string | undefined>;
  expandedKeys: Set<string>;
}

export function nodeKey(rootId: string, path: string): string {
  return `${rootId}:${path}`;
}

export function useFilesystemTree() {
  const [roots, setRoots] = useState<FilesystemRootInfo[]>([]);
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [childrenByKey, setChildrenByKey] = useState<Record<string, FsDirEntry[] | undefined>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [errorByKey, setErrorByKey] = useState<Record<string, string | undefined>>({});
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const refreshRoots = useCallback(async () => {
    setRootsLoading(true);
    setRootsError(null);
    try {
      const data = await fetchFsRoots();
      setRoots(data.roots);
    } catch (e: any) {
      setRootsError(e?.message ?? 'Failed to load filesystem roots');
    } finally {
      setRootsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshRoots();
  }, [refreshRoots]);

  const loadChildren = useCallback(
    async (rootId: string, path: string, force = false) => {
      const key = nodeKey(rootId, path);
      if (!force && childrenByKey[key] !== undefined) return;
      setLoadingKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setErrorByKey((prev) => ({ ...prev, [key]: undefined }));
      try {
        const data = await fetchFsEntries(rootId, path || '.');
        setChildrenByKey((prev) => ({ ...prev, [key]: data.entries }));
      } catch (e: any) {
        setErrorByKey((prev) => ({ ...prev, [key]: e?.message ?? 'Failed to load' }));
      } finally {
        setLoadingKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [childrenByKey]
  );

  const toggleExpand = useCallback(
    (rootId: string, path: string) => {
      const key = nodeKey(rootId, path);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
          loadChildren(rootId, path);
        }
        return next;
      });
    },
    [loadChildren]
  );

  const expand = useCallback(
    (rootId: string, path: string) => {
      const key = nodeKey(rootId, path);
      setExpandedKeys((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      loadChildren(rootId, path);
    },
    [loadChildren]
  );

  const collapse = useCallback((rootId: string, path: string) => {
    const key = nodeKey(rootId, path);
    setExpandedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const refreshNode = useCallback(
    (rootId: string, path: string) => {
      loadChildren(rootId, path, true);
    },
    [loadChildren]
  );

  const isExpanded = useCallback(
    (rootId: string, path: string) => expandedKeys.has(nodeKey(rootId, path)),
    [expandedKeys]
  );

  const isLoading = useCallback(
    (rootId: string, path: string) => loadingKeys.has(nodeKey(rootId, path)),
    [loadingKeys]
  );

  const getError = useCallback(
    (rootId: string, path: string) => errorByKey[nodeKey(rootId, path)],
    [errorByKey]
  );

  const getChildren = useCallback(
    (rootId: string, path: string) => childrenByKey[nodeKey(rootId, path)],
    [childrenByKey]
  );

  return {
    roots,
    rootsLoading,
    rootsError,
    refreshRoots,
    toggleExpand,
    expand,
    collapse,
    isExpanded,
    isLoading,
    getError,
    getChildren,
    refreshNode,
  };
}
