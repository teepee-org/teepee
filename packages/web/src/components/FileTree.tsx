import { useRef } from 'react';
import { useFilesystemTree, nodeKey } from '../hooks/useFilesystemTree';
import type { FsDirEntry } from '../api';

export interface FileSelection {
  rootId: string;
  rootKind: 'workspace' | 'host';
  path: string; // '' for root
  name: string; // leaf basename, or root id for root node
  type: 'root' | 'directory' | 'file';
}

interface Props {
  selected: FileSelection | null;
  onSelect: (selection: FileSelection) => void;
  onContextMenu?: (selection: FileSelection, event: React.MouseEvent) => void;
}

export function FileTree({ selected, onSelect, onContextMenu }: Props) {
  const tree = useFilesystemTree();
  const containerRef = useRef<HTMLDivElement>(null);

  if (tree.rootsLoading) {
    return (
      <div className="fs-tree-status">
        <span className="dots">loading filesystem…</span>
      </div>
    );
  }
  if (tree.rootsError) {
    return (
      <div className="fs-tree-status fs-tree-error">
        <div>{tree.rootsError}</div>
        <button className="fs-tree-retry" onClick={tree.refreshRoots}>Retry</button>
      </div>
    );
  }
  if (tree.roots.length === 0) {
    return (
      <div className="fs-tree-status">
        No filesystem roots configured for your role.
      </div>
    );
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!selected) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (selected.type !== 'file') {
          const expanded = tree.isExpanded(selected.rootId, selected.path);
          if (!expanded) {
            tree.expand(selected.rootId, selected.path);
          }
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (selected.type !== 'file' && tree.isExpanded(selected.rootId, selected.path)) {
          tree.collapse(selected.rootId, selected.path);
        } else if (selected.path) {
          const parentPath = selected.path.includes('/')
            ? selected.path.slice(0, selected.path.lastIndexOf('/'))
            : '';
          const root = tree.roots.find((r) => r.id === selected.rootId);
          if (root) {
            onSelect({
              rootId: selected.rootId,
              rootKind: root.kind,
              path: parentPath,
              name: parentPath ? parentPath.split('/').pop()! : root.id,
              type: parentPath ? 'directory' : 'root',
            });
          }
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (selected.type === 'file') {
          // selection already triggered onSelect; nothing extra
        } else {
          const expanded = tree.isExpanded(selected.rootId, selected.path);
          if (expanded) tree.collapse(selected.rootId, selected.path);
          else tree.expand(selected.rootId, selected.path);
        }
        break;
    }
  };

  const moveSelection = (delta: number) => {
    const flat = flattenVisible(tree);
    if (flat.length === 0) return;
    const currentIndex = selected
      ? flat.findIndex((item) => item.key === nodeKey(selected.rootId, selected.path))
      : -1;
    const nextIndex = Math.max(0, Math.min(flat.length - 1, currentIndex + delta));
    const next = flat[nextIndex];
    onSelect(next.selection);
  };

  return (
    <div
      className="fs-tree"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="tree"
    >
      {tree.roots.map((root) => {
        const isRootSelected =
          !!selected && selected.rootId === root.id && selected.path === '' && selected.type === 'root';
        return (
          <RootNode
            key={root.id}
            rootId={root.id}
            rootKind={root.kind}
            rootPath={root.path}
            expanded={tree.isExpanded(root.id, '')}
            loading={tree.isLoading(root.id, '')}
            error={tree.getError(root.id, '')}
            children={tree.getChildren(root.id, '')}
            selected={selected}
            isRootSelected={isRootSelected}
            onToggle={() => tree.toggleExpand(root.id, '')}
            onSelect={onSelect}
            onRefresh={() => tree.refreshNode(root.id, '')}
            onContextMenu={onContextMenu}
            tree={tree}
          />
        );
      })}
    </div>
  );
}

interface RootNodeProps {
  rootId: string;
  rootKind: 'workspace' | 'host';
  rootPath: string;
  expanded: boolean;
  loading: boolean;
  error: string | undefined;
  children: FsDirEntry[] | undefined;
  selected: FileSelection | null;
  isRootSelected: boolean;
  onToggle: () => void;
  onSelect: (selection: FileSelection) => void;
  onRefresh: () => void;
  onContextMenu?: (selection: FileSelection, event: React.MouseEvent) => void;
  tree: ReturnType<typeof useFilesystemTree>;
}

function RootNode({
  rootId,
  rootKind,
  rootPath,
  expanded,
  loading,
  error,
  children,
  selected,
  isRootSelected,
  onToggle,
  onSelect,
  onRefresh,
  onContextMenu,
  tree,
}: RootNodeProps) {
  const handleSelect = () => {
    onSelect({ rootId, rootKind, path: '', name: rootId, type: 'root' });
  };
  return (
    <div className="fs-tree-root-node" role="treeitem" aria-expanded={expanded}>
      <div
        className={`fs-tree-row fs-tree-row-root ${isRootSelected ? 'selected' : ''}`}
        onClick={() => {
          handleSelect();
          onToggle();
        }}
        title={rootPath}
      >
        <span className="fs-tree-chevron">{expanded ? '▾' : '▸'}</span>
        <span className="fs-tree-icon">{rootKind === 'workspace' ? '📁' : '🗂️'}</span>
        <span className="fs-tree-name">{rootId}</span>
        <span className="fs-tree-root-hint">{rootPath}</span>
      </div>
      {expanded && (
        <div className="fs-tree-children" role="group">
          {loading && <div className="fs-tree-status fs-tree-leaf"><span className="dots">…</span></div>}
          {error && (
            <div className="fs-tree-status fs-tree-leaf fs-tree-error">
              <span>{error}</span>
              <button className="fs-tree-retry" onClick={onRefresh}>Retry</button>
            </div>
          )}
          {children && children.length === 0 && !loading && !error && (
            <div className="fs-tree-status fs-tree-leaf">empty</div>
          )}
          {children?.map((entry) => (
            <EntryNode
              key={nodeKey(rootId, entry.path)}
              rootId={rootId}
              rootKind={rootKind}
              entry={entry}
              depth={1}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              tree={tree}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface EntryNodeProps {
  rootId: string;
  rootKind: 'workspace' | 'host';
  entry: FsDirEntry;
  depth: number;
  selected: FileSelection | null;
  onSelect: (selection: FileSelection) => void;
  onContextMenu?: (selection: FileSelection, event: React.MouseEvent) => void;
  tree: ReturnType<typeof useFilesystemTree>;
}

function EntryNode({
  rootId,
  rootKind,
  entry,
  depth,
  selected,
  onSelect,
  onContextMenu,
  tree,
}: EntryNodeProps) {
  const isDir = entry.type === 'directory';
  const expanded = isDir && tree.isExpanded(rootId, entry.path);
  const loading = isDir && tree.isLoading(rootId, entry.path);
  const error = isDir ? tree.getError(rootId, entry.path) : undefined;
  const children = isDir ? tree.getChildren(rootId, entry.path) : undefined;

  const isSelected =
    !!selected &&
    selected.rootId === rootId &&
    selected.path === entry.path &&
    selected.type === (isDir ? 'directory' : 'file');

  const selection: FileSelection = {
    rootId,
    rootKind,
    path: entry.path,
    name: entry.name,
    type: isDir ? 'directory' : 'file',
  };

  const handleRowClick = () => {
    onSelect(selection);
    if (isDir) tree.toggleExpand(rootId, entry.path);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault();
      onSelect(selection);
      onContextMenu(selection, e);
    }
  };

  return (
    <div className="fs-tree-node" role="treeitem" aria-expanded={isDir ? expanded : undefined}>
      <div
        className={`fs-tree-row ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${depth * 14}px` }}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
        title={entry.path}
      >
        <span className="fs-tree-chevron">
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="fs-tree-icon">{isDir ? '📂' : fileIcon(entry.name)}</span>
        <span className="fs-tree-name">{entry.name}</span>
      </div>
      {isDir && expanded && (
        <div className="fs-tree-children" role="group">
          {loading && (
            <div className="fs-tree-status fs-tree-leaf" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              <span className="dots">…</span>
            </div>
          )}
          {error && (
            <div
              className="fs-tree-status fs-tree-leaf fs-tree-error"
              style={{ paddingLeft: `${(depth + 1) * 14}px` }}
            >
              <span>{error}</span>
              <button className="fs-tree-retry" onClick={() => tree.refreshNode(rootId, entry.path)}>
                Retry
              </button>
            </div>
          )}
          {children && children.length === 0 && !loading && !error && (
            <div className="fs-tree-status fs-tree-leaf" style={{ paddingLeft: `${(depth + 1) * 14}px` }}>
              empty
            </div>
          )}
          {children?.map((child) => (
            <EntryNode
              key={nodeKey(rootId, child.path)}
              rootId={rootId}
              rootKind={rootKind}
              entry={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              tree={tree}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'md':
    case 'mdx': return '📝';
    case 'json': return '🔧';
    case 'yaml':
    case 'yml': return '⚙️';
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx': return '💻';
    case 'py': return '🐍';
    case 'go': return '🦫';
    case 'rs': return '🦀';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp': return '🖼️';
    case 'pdf': return '📄';
    default: return '📄';
  }
}

interface FlatItem {
  key: string;
  selection: FileSelection;
}

function flattenVisible(tree: ReturnType<typeof useFilesystemTree>): FlatItem[] {
  const items: FlatItem[] = [];
  for (const root of tree.roots) {
    items.push({
      key: nodeKey(root.id, ''),
      selection: {
        rootId: root.id,
        rootKind: root.kind,
        path: '',
        name: root.id,
        type: 'root',
      },
    });
    if (tree.isExpanded(root.id, '')) {
      const children = tree.getChildren(root.id, '');
      if (children) walk(children, root.id, root.kind);
    }
  }
  return items;

  function walk(entries: FsDirEntry[], rootId: string, rootKind: 'workspace' | 'host') {
    for (const entry of entries) {
      items.push({
        key: nodeKey(rootId, entry.path),
        selection: {
          rootId,
          rootKind,
          path: entry.path,
          name: entry.name,
          type: entry.type === 'directory' ? 'directory' : 'file',
        },
      });
      if (entry.type === 'directory' && tree.isExpanded(rootId, entry.path)) {
        const children = tree.getChildren(rootId, entry.path);
        if (children) walk(children, rootId, rootKind);
      }
    }
  }
}
