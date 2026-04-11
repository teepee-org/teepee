import { useState, useEffect, useRef } from 'react';
import {
  resolveReference,
  fetchWorkspaceFile,
  fetchArtifact,
  fetchArtifactVersion,
  fetchArtifactVersions,
  workspaceDownloadUrl,
  artifactDownloadUrl,
  type ResolvedReference,
  type ArtifactSummary,
  type ArtifactVersion,
} from '../api';
import { MarkdownRenderer } from './MarkdownRenderer';
import { highlightCodeAsLines } from './codeHighlight';

interface Props {
  href: string;
  projectPath?: string;
  onClose: () => void;
  onOpenReference?: (href: string) => void;
}

type ViewerState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'workspace-file'; resolved: ResolvedReference; content: string }
  | { status: 'artifact-document'; resolved: ResolvedReference; artifact: ArtifactSummary; version: ArtifactVersion }
  | { status: 'not-previewable'; resolved: ResolvedReference };

export function ReferenceViewer({ href, projectPath, onClose, onOpenReference }: Props) {
  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const codeRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const resolved = await resolveReference(href);
        if (cancelled) return;

        if (resolved.targetType === 'workspace-file' && resolved.fetch.kind === 'workspace') {
          if (resolved.mime.startsWith('image/') || resolved.mime === 'application/pdf') {
            setState({ status: 'not-previewable', resolved });
          } else {
            const file = await fetchWorkspaceFile(resolved.fetch.path);
            if (cancelled) return;
            if (file.binary) {
              setState({ status: 'not-previewable', resolved });
            } else {
              setState({ status: 'workspace-file', resolved, content: file.content });
            }
          }
        } else if (resolved.fetch.kind === 'artifact-document') {
          const artifact = await fetchArtifact(resolved.fetch.artifactId);
          if (cancelled) return;
          let versionId: number | null = null;
          if (resolved.fetch.version) {
            const allVersions = await fetchArtifactVersions(resolved.fetch.artifactId);
            if (cancelled) return;
            const match = allVersions.find((v) => v.version === resolved.fetch.version);
            if (!match) {
              setState({ status: 'error', message: `Artifact version v${resolved.fetch.version} not found` });
              return;
            }
            versionId = match.id;
          } else {
            versionId = artifact.current_version_id;
          }
          if (!versionId) {
            setState({ status: 'error', message: 'Artifact has no versions' });
            return;
          }
          const version = await fetchArtifactVersion(resolved.fetch.artifactId, versionId);
          if (cancelled) return;
          setState({ status: 'artifact-document', resolved, artifact, version });
        } else {
          setState({ status: 'error', message: 'Unsupported reference type' });
        }
      } catch (e: any) {
        if (!cancelled) setState({ status: 'error', message: e.message || 'Failed to resolve' });
      }
    }

    load();
    return () => { cancelled = true; };
  }, [href]);

  useEffect(() => {
    if (state.status === 'workspace-file' && state.resolved.selection.line && codeRef.current) {
      const lineEl = codeRef.current.querySelector(`[data-line="${state.resolved.selection.line}"]`);
      if (lineEl instanceof HTMLElement && typeof lineEl.scrollIntoView === 'function') {
        lineEl.scrollIntoView({ block: 'center' });
      }
      lineEl?.classList.add('highlighted-line');
    }
  }, [state]);

  if (state.status === 'loading') {
    return (
      <div className="reference-viewer">
        <div className="reference-viewer-header">
          <span>Loading...</span>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="reference-viewer-body">Loading...</div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="reference-viewer">
        <div className="reference-viewer-header">
          <span>Error</span>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="reference-viewer-body reference-viewer-error">{state.message}</div>
      </div>
    );
  }

  if (state.status === 'not-previewable') {
    const downloadUrl = state.resolved.fetch.kind === 'workspace'
      ? workspaceDownloadUrl(state.resolved.fetch.path, 'attachment')
      : undefined;
    const inlineUrl = state.resolved.fetch.kind === 'workspace'
      ? workspaceDownloadUrl(state.resolved.fetch.path, 'inline')
      : undefined;
    const isImage = state.resolved.mime.startsWith('image/');
    const isPdf = state.resolved.mime === 'application/pdf';
    return (
      <div className="reference-viewer">
        <div className="reference-viewer-header">
          <span className="reference-viewer-title">{state.resolved.displayName}</span>
          <div className="reference-viewer-actions">
            <button onClick={() => navigator.clipboard.writeText(state.resolved.canonicalUri)}>
              Copy ref
            </button>
            {downloadUrl && <a href={downloadUrl} download>Download</a>}
            <button onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="reference-viewer-body">
          {isImage && inlineUrl ? (
            <div className="reference-viewer-image">
              <img src={inlineUrl} alt={state.resolved.displayName} />
            </div>
          ) : isPdf && inlineUrl ? (
            <div className="reference-viewer-pdf">
              <iframe src={inlineUrl} title={state.resolved.displayName} style={{ width: '100%', height: '80vh', border: 'none' }} />
            </div>
          ) : (
            <>
              <p>This file cannot be previewed. Use download to view it.</p>
              <p className="reference-viewer-meta">{state.resolved.mime} · {state.resolved.language}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  if (state.status === 'artifact-document') {
    const { resolved, artifact, version } = state;
    return (
      <div className="reference-viewer">
        <div className="reference-viewer-header">
          <div className="reference-viewer-title">
            <h2>{artifact.title}</h2>
            <span className="reference-viewer-meta">
              {artifact.kind} · v{version.version} · {artifact.status}
            </span>
          </div>
          <div className="reference-viewer-actions">
            <button onClick={() => navigator.clipboard.writeText(resolved.canonicalUri)}>
              Copy ref
            </button>
            <a href={artifactDownloadUrl(artifact.id, version.id)} download>Download</a>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="reference-viewer-body reference-viewer-markdown">
          <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>
            {version.body}
          </MarkdownRenderer>
        </div>
      </div>
    );
  }

  // workspace-file
  const { resolved, content } = state;
  const isMarkdown = resolved.language === 'markdown';
  const highlightedLines = isMarkdown ? null : highlightCodeAsLines(content, resolved.language);
  const downloadUrl = resolved.fetch.kind === 'workspace'
    ? workspaceDownloadUrl(resolved.fetch.path, 'attachment')
    : undefined;

  return (
    <div className="reference-viewer">
      <div className="reference-viewer-header">
        <div className="reference-viewer-title">
          <h2>{resolved.displayName}</h2>
          <span className="reference-viewer-meta">
            {resolved.fetch.kind === 'workspace' ? resolved.fetch.path : ''} · {resolved.language}
          </span>
        </div>
        <div className="reference-viewer-actions">
          <button onClick={() => navigator.clipboard.writeText(resolved.canonicalUri)}>
            Copy ref
          </button>
          <button onClick={() => navigator.clipboard.writeText(content)}>
            Copy content
          </button>
          {downloadUrl && <a href={downloadUrl} download>Download</a>}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="reference-viewer-body">
        {isMarkdown ? (
          <div className="reference-viewer-markdown">
            <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>
              {content}
            </MarkdownRenderer>
          </div>
        ) : (
          <pre className="reference-viewer-code" ref={codeRef}>
            <code>
              {highlightedLines?.map((line, i) => (
                <span key={i} className="code-line" data-line={i + 1}>
                  <span className="line-number">{i + 1}</span>
                  <span
                    className="code-line-content"
                    dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }}
                  />
                  {'\n'}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  );
}
