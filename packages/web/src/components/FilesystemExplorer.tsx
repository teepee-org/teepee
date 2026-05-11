import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileTree, type FileSelection } from './FileTree';
import { useFilesystemTree } from '../hooks/useFilesystemTree';
import {
  createFsDirectory,
  uploadFsFile,
  type FsConflictPolicy,
  type FsUploadOutcome,
} from '../api';

export interface ContextMenuPosition {
  x: number;
  y: number;
  selection: FileSelection;
}

interface Props {
  selection: FileSelection | null;
  onSelect: (selection: FileSelection) => void;
  onNotify: (message: string, variant: 'success' | 'error') => void;
  isOwner: boolean;
}

interface UploadTarget {
  rootId: string;
  rootKind: 'workspace' | 'host';
  dirPath: string; // '' (or '.') for the root itself
}

interface ConflictState {
  files: File[];
  index: number;
  suggestedName: string;
  resolve: (choice: 'overwrite' | 'rename' | 'skip') => void;
}

export function FilesystemExplorer({ selection, onSelect, onNotify, isOwner }: Props) {
  const tree = useFilesystemTree();
  const [menu, setMenu] = useState<ContextMenuPosition | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

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

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = () => setAddMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [addMenuOpen]);

  const handleContextMenu = (sel: FileSelection, event: React.MouseEvent) => {
    setMenu({ x: event.clientX, y: event.clientY, selection: sel });
  };

  const copyReference = async (sel: FileSelection) => {
    const link = markdownLink(sel);
    try {
      await navigator.clipboard.writeText(link);
      onNotify(`Copied ${link} to clipboard — paste in any message.`, 'success');
    } catch {
      onNotify('Copy failed — your browser may have blocked clipboard access.', 'error');
    }
    setMenu(null);
  };

  const copyAgentPrompt = async (sel: FileSelection, agent: string) => {
    const link = markdownLink(sel);
    const text = `@${agent} please review ${link} and suggest changes.`;
    try {
      await navigator.clipboard.writeText(text);
      onNotify(`Copied @${agent} prompt to clipboard — paste in any topic.`, 'success');
    } catch {
      onNotify('Copy failed — your browser may have blocked clipboard access.', 'error');
    }
    setMenu(null);
  };

  const uploadTarget = useMemo<UploadTarget | null>(
    () => resolveUploadTarget(selection, tree.roots),
    [selection, tree.roots]
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!isOwner || !uploadTarget || files.length === 0) return;
      setUploading(true);
      let succeeded = 0;
      let failed = 0;
      let skipped = 0;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const outcome = await attemptUpload(uploadTarget, file, file.name, 'fail');
        if (outcome.kind === 'ok') {
          succeeded++;
          continue;
        }
        if (outcome.kind === 'conflict') {
          const choice = await new Promise<'overwrite' | 'rename' | 'skip'>((resolve) => {
            setConflict({
              files,
              index: i,
              suggestedName: outcome.suggestedName,
              resolve,
            });
          });
          setConflict(null);
          if (choice === 'skip') {
            skipped++;
            continue;
          }
          const policy: FsConflictPolicy = choice === 'overwrite' ? 'overwrite' : 'rename';
          const second = await attemptUpload(uploadTarget, file, file.name, policy);
          if (second.kind === 'ok') {
            succeeded++;
          } else {
            failed++;
            const err =
              second.kind === 'error'
                ? second.error
                : `Unexpected conflict for ${file.name}`;
            onNotify(`Failed to upload ${file.name}: ${err}`, 'error');
          }
          continue;
        }
        failed++;
        onNotify(`Failed to upload ${file.name}: ${outcome.error}`, 'error');
      }
      setUploading(false);
      tree.refreshNode(uploadTarget.rootId, uploadTarget.dirPath);
      if (succeeded > 0) {
        const label = succeeded === 1 ? '1 file' : `${succeeded} files`;
        const extras: string[] = [];
        if (skipped > 0) extras.push(`${skipped} skipped`);
        if (failed > 0) extras.push(`${failed} failed`);
        const suffix = extras.length ? ` (${extras.join(', ')})` : '';
        onNotify(`Uploaded ${label}${suffix}.`, 'success');
      }
    },
    [isOwner, uploadTarget, tree, onNotify]
  );

  const onTriggerFilePicker = () => {
    setAddMenuOpen(false);
    fileInputRef.current?.click();
  };

  const onFilePickerChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length > 0) void uploadFiles(files);
  };

  const onStartNewFolder = () => {
    setAddMenuOpen(false);
    setNewFolderName('');
  };

  const submitNewFolder = useCallback(async () => {
    if (!isOwner || !uploadTarget || newFolderName === null) return;
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setNewFolderName(null);
      return;
    }
    try {
      await createFsDirectory({
        rootId: uploadTarget.rootId,
        dirPath: uploadTarget.dirPath,
        name: trimmed,
      });
      onNotify(`Created folder ${trimmed}/`, 'success');
      tree.refreshNode(uploadTarget.rootId, uploadTarget.dirPath);
    } catch (err: any) {
      onNotify(err?.message ?? 'Failed to create folder', 'error');
    }
    setNewFolderName(null);
  }, [isOwner, newFolderName, uploadTarget, tree, onNotify]);

  const onDragEnter = (event: React.DragEvent) => {
    if (!isOwner || !uploadTarget || !hasFileDrag(event)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const onDragOver = (event: React.DragEvent) => {
    if (!isOwner || !uploadTarget || !hasFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: React.DragEvent) => {
    if (!isOwner || !uploadTarget) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };
  const onDrop = (event: React.DragEvent) => {
    if (!isOwner || !uploadTarget) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) void uploadFiles(files);
  };

  const onPaste = (event: React.ClipboardEvent) => {
    if (!isOwner || !uploadTarget) return;
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void uploadFiles(files);
  };

  const targetLabel = uploadTarget
    ? uploadTarget.dirPath && uploadTarget.dirPath !== '.'
      ? `${uploadTarget.rootId}/${uploadTarget.dirPath}/`
      : `${uploadTarget.rootId}/`
    : null;

  return (
    <div className="fs-explorer">
      <div className="fs-explorer-header">
        <h3>Files</h3>
        {isOwner && (
          <div className="fs-explorer-actions">
            <button
              type="button"
              className="fs-explorer-add"
              aria-label="Add file or folder"
              title={uploadTarget ? `Add to ${targetLabel}` : 'Add'}
              disabled={!uploadTarget || uploading}
              onClick={(e) => {
                e.stopPropagation();
                setAddMenuOpen((v) => !v);
              }}
            >
              + Add
            </button>
            {addMenuOpen && (
              <div className="fs-context-menu fs-add-menu" role="menu" onClick={(e) => e.stopPropagation()}>
                <button className="fs-context-menu-item" onClick={onTriggerFilePicker}>
                  ⬆️ Upload files…
                </button>
                <button className="fs-context-menu-item" onClick={onStartNewFolder}>
                  📁 New folder…
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div
        className={`fs-explorer-tree-wrapper ${dragActive ? 'fs-explorer-drag-active' : ''}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPaste={onPaste}
        tabIndex={isOwner ? 0 : -1}
      >
        <FileTree
          selected={selection}
          onSelect={onSelect}
          onContextMenu={handleContextMenu}
          tree={tree}
        />
        {dragActive && targetLabel && (
          <div className="fs-dropzone-overlay" aria-hidden="true">
            <div className="fs-dropzone-message">Drop to upload to <strong>{targetLabel}</strong></div>
          </div>
        )}
        {newFolderName !== null && uploadTarget && (
          <NewFolderInput
            value={newFolderName}
            targetLabel={targetLabel ?? ''}
            onChange={setNewFolderName}
            onSubmit={submitNewFolder}
            onCancel={() => setNewFolderName(null)}
          />
        )}
      </div>
      {isOwner && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onFilePickerChange}
          data-testid="fs-file-input"
        />
      )}
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
      {conflict && (
        <ConflictDialog
          fileName={conflict.files[conflict.index].name}
          suggestedName={conflict.suggestedName}
          remaining={conflict.files.length - conflict.index - 1}
          onChoose={conflict.resolve}
        />
      )}
    </div>
  );
}

async function attemptUpload(
  target: UploadTarget,
  file: File,
  filename: string,
  onConflict: FsConflictPolicy
): Promise<FsUploadOutcome> {
  return uploadFsFile({
    rootId: target.rootId,
    dirPath: target.dirPath,
    filename,
    body: file,
    onConflict,
  });
}

function hasFileDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types ?? []).includes('Files');
}

function resolveUploadTarget(
  selection: FileSelection | null,
  roots: Array<{ id: string; kind: 'workspace' | 'host' }>
): UploadTarget | null {
  if (selection) {
    if (selection.type === 'root') {
      return { rootId: selection.rootId, rootKind: selection.rootKind, dirPath: '.' };
    }
    if (selection.type === 'directory') {
      return {
        rootId: selection.rootId,
        rootKind: selection.rootKind,
        dirPath: selection.path || '.',
      };
    }
    if (selection.type === 'file') {
      const parent = selection.path.includes('/')
        ? selection.path.slice(0, selection.path.lastIndexOf('/'))
        : '.';
      return { rootId: selection.rootId, rootKind: selection.rootKind, dirPath: parent };
    }
  }
  const fallback = roots.find((r) => r.id === 'workspace') ?? roots[0];
  if (!fallback) return null;
  return { rootId: fallback.id, rootKind: fallback.kind, dirPath: '.' };
}

interface ConflictDialogProps {
  fileName: string;
  suggestedName: string;
  remaining: number;
  onChoose: (choice: 'overwrite' | 'rename' | 'skip') => void;
}

function ConflictDialog({ fileName, suggestedName, remaining, onChoose }: ConflictDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onChoose('skip');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose]);
  return (
    <div className="fs-modal-backdrop" role="dialog" aria-modal="true" aria-label="File already exists">
      <div className="fs-modal">
        <h4>File already exists</h4>
        <p>
          <code>{fileName}</code> is already in this folder.
          {remaining > 0 && <span> ({remaining} more queued)</span>}
        </p>
        <div className="fs-modal-actions">
          <button type="button" onClick={() => onChoose('rename')} autoFocus>
            Keep both (save as <code>{suggestedName}</code>)
          </button>
          <button type="button" onClick={() => onChoose('overwrite')}>
            Replace
          </button>
          <button type="button" onClick={() => onChoose('skip')}>
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

interface NewFolderInputProps {
  value: string;
  targetLabel: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function NewFolderInput({ value, targetLabel, onChange, onSubmit, onCancel }: NewFolderInputProps) {
  return (
    <div className="fs-new-folder">
      <span className="fs-new-folder-prefix">{targetLabel}</span>
      <input
        autoFocus
        type="text"
        value={value}
        placeholder="folder name"
        aria-label="New folder name"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={onSubmit}
      />
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

/**
 * Build a markdown link for a selection, matching the format used by
 * the compose-box file picker (`[basename](canonicalUri)`).
 */
export function markdownLink(selection: FileSelection): string {
  const uri = canonicalUri(selection);
  if (selection.type === 'root') {
    return `[${selection.rootId}/](${uri})`;
  }
  const label = selection.type === 'directory'
    ? `${selection.name}/`
    : selection.name;
  return `[${label}](${uri})`;
}
