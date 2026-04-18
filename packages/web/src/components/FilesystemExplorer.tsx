import { useEffect, useState } from 'react';
import { FileTree, type FileSelection } from './FileTree';

export interface ContextMenuPosition {
  x: number;
  y: number;
  selection: FileSelection;
}

interface Props {
  selection: FileSelection | null;
  onSelect: (selection: FileSelection) => void;
  onNotify: (message: string, variant: 'success' | 'error') => void;
}

export function FilesystemExplorer({ selection, onSelect, onNotify }: Props) {
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  const handleContextMenu = (sel: FileSelection, event: React.MouseEvent) => {
    if (sel.type !== 'file') return;
    setMenu({ x: event.clientX, y: event.clientY, selection: sel });
  };

  const copyReference = async (sel: FileSelection) => {
    const uri = canonicalUri(sel);
    try {
      await navigator.clipboard.writeText(uri);
      onNotify(`Copied ${uri} to clipboard — paste in any message.`, 'success');
    } catch {
      onNotify('Copy failed — your browser may have blocked clipboard access.', 'error');
    }
    setMenu(null);
  };

  const copyAgentPrompt = async (sel: FileSelection, agent: string) => {
    const uri = canonicalUri(sel);
    const text = `@${agent} please review ${uri} and suggest changes.`;
    try {
      await navigator.clipboard.writeText(text);
      onNotify(`Copied @${agent} prompt to clipboard — paste in any topic.`, 'success');
    } catch {
      onNotify('Copy failed — your browser may have blocked clipboard access.', 'error');
    }
    setMenu(null);
  };

  return (
    <div className="fs-explorer">
      <div className="fs-explorer-header">
        <h3>Files</h3>
      </div>
      <div className="fs-explorer-tree-wrapper">
        <FileTree selected={selection} onSelect={onSelect} onContextMenu={handleContextMenu} />
      </div>
      {menu && (
        <div
          className="fs-context-menu"
          style={{ position: 'fixed', top: menu.y, left: menu.x, zIndex: 1000 }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="fs-context-menu-item"
            onClick={() => copyReference(menu.selection)}
          >
            📋 Copy reference URI
          </button>
          <button
            className="fs-context-menu-item"
            onClick={() => copyAgentPrompt(menu.selection, 'coder')}
          >
            🤖 Copy prompt: @coder review
          </button>
          <button
            className="fs-context-menu-item"
            onClick={() => copyAgentPrompt(menu.selection, 'architect')}
          >
            🏛️ Copy prompt: @architect review
          </button>
        </div>
      )}
    </div>
  );
}

export function canonicalUri(selection: FileSelection): string {
  if (selection.type === 'root') {
    return selection.rootId === 'workspace'
      ? 'teepee:/workspace/'
      : `teepee:/fs/${selection.rootId}/`;
  }
  const suffix = selection.type === 'directory' ? '/' : '';
  if (selection.rootId === 'workspace') {
    return `teepee:/workspace/${selection.path}${suffix}`;
  }
  return `teepee:/fs/${selection.rootId}/${selection.path}${suffix}`;
}
