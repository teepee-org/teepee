import { useEffect, useState } from 'react';
import { fetchFileAtRoot, fileDownloadUrl, type WorkspaceFileResponse } from '../api';
import { MarkdownRenderer } from './MarkdownRenderer';
import { highlightCodeAsLines } from './codeHighlight';
import type { FileSelection } from './FileTree';

interface Props {
  selection: FileSelection;
  projectPath?: string;
  onOpenReference?: (href: string) => void;
}

type ViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string; code?: number }
  | { status: 'text'; response: Extract<WorkspaceFileResponse, { binary?: false }> }
  | { status: 'binary'; response: Extract<WorkspaceFileResponse, { binary: true }> }
  | { status: 'not-file' };

export function FilePreview({ selection, projectPath, onOpenReference }: Props) {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    if (selection.type !== 'file') {
      setState({ status: 'not-file' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });

    fetchFileAtRoot(selection.rootId, selection.path)
      .then((response) => {
        if (cancelled) return;
        if (response.binary) {
          setState({ status: 'binary', response });
        } else {
          setState({ status: 'text', response });
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        const message = err?.message ?? 'Failed to load file';
        setState({ status: 'error', message });
      });

    return () => {
      cancelled = true;
    };
  }, [selection.rootId, selection.path, selection.type]);

  if (selection.type !== 'file') {
    return (
      <div className="file-preview file-preview-empty">
        {selection.type === 'root' ? (
          <p>
            Browsing <strong>{selection.name}</strong>. Select a file to preview.
          </p>
        ) : (
          <p>
            Directory <strong>{selection.path || selection.name}</strong>. Select a file to
            preview.
          </p>
        )}
      </div>
    );
  }

  const breadcrumb = (
    <div className="file-preview-breadcrumb">
      <span className="file-preview-root">{selection.rootId}</span>
      <span className="file-preview-sep">/</span>
      <span className="file-preview-path">{selection.path}</span>
    </div>
  );

  if (state.status === 'loading') {
    return (
      <div className="file-preview">
        {breadcrumb}
        <div className="file-preview-status">
          <span className="dots">loading…</span>
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="file-preview">
        {breadcrumb}
        <div className="file-preview-status file-preview-error">
          <div>{state.message}</div>
          <a
            className="file-preview-download"
            href={fileDownloadUrl(selection.rootId, selection.path, 'attachment')}
            download
          >
            Try download
          </a>
        </div>
      </div>
    );
  }

  if (state.status === 'binary') {
    const isImage = state.response.mime.startsWith('image/');
    const isPdf = state.response.mime === 'application/pdf';
    return (
      <div className="file-preview">
        {breadcrumb}
        <div className="file-preview-toolbar">
          <span className="file-preview-meta">
            {state.response.mime} · {formatSize(state.response.size)}
          </span>
          <a
            className="file-preview-download"
            href={fileDownloadUrl(selection.rootId, selection.path, 'attachment')}
            download
          >
            Download
          </a>
        </div>
        {isImage ? (
          <div className="file-preview-image">
            <img
              src={fileDownloadUrl(selection.rootId, selection.path, 'inline')}
              alt={selection.name}
              style={{ maxWidth: '100%', maxHeight: '100%' }}
            />
          </div>
        ) : isPdf ? (
          <iframe
            className="file-preview-pdf"
            src={fileDownloadUrl(selection.rootId, selection.path, 'inline')}
            title={selection.name}
          />
        ) : (
          <div className="file-preview-status">
            Binary file ({state.response.mime}, {formatSize(state.response.size)}). Use
            Download to view.
          </div>
        )}
      </div>
    );
  }

  // text content
  const content = state.response.content;
  const mime = state.response.mime;
  const size = state.response.size;
  const isMarkdown = mime === 'text/markdown' || selection.name.endsWith('.md') || selection.name.endsWith('.mdx');
  const language = inferLanguage(selection.name, mime);

  return (
    <div className="file-preview">
      {breadcrumb}
      <div className="file-preview-toolbar">
        <span className="file-preview-meta">
          {mime} · {formatSize(size)}
        </span>
        <button
          className="file-preview-copy"
          onClick={() => navigator.clipboard?.writeText(content)}
          title="Copy file content"
        >
          Copy
        </button>
        <a
          className="file-preview-download"
          href={fileDownloadUrl(selection.rootId, selection.path, 'attachment')}
          download
        >
          Download
        </a>
      </div>
      {isMarkdown ? (
        <div className="file-preview-markdown">
          <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>
            {content}
          </MarkdownRenderer>
        </div>
      ) : (
        <CodeBlock content={content} language={language} />
      )}
    </div>
  );
}

function CodeBlock({ content, language }: { content: string; language: string }) {
  let lines: string[];
  try {
    lines = highlightCodeAsLines(content, language);
  } catch {
    // Fallback: plain lines if highlight fails
    lines = content.split('\n').map(escapeHtml);
  }
  return (
    <pre className={`file-preview-code language-${language}`}>
      <code>
        {lines.map((line, idx) => (
          <span key={idx} className="file-preview-code-line">
            <span className="file-preview-code-lineno">{idx + 1}</span>
            <span
              className="file-preview-code-content"
              dangerouslySetInnerHTML={{ __html: line || '&nbsp;' }}
            />
          </span>
        ))}
      </code>
    </pre>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inferLanguage(name: string, mime: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx': return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': return 'javascript';
    case 'py': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'json': return 'json';
    case 'yml':
    case 'yaml': return 'yaml';
    case 'sh':
    case 'bash': return 'bash';
    case 'sql': return 'sql';
    case 'html':
    case 'xml': return 'xml';
    case 'css': return 'css';
    case 'md':
    case 'mdx': return 'markdown';
    case 'java': return 'java';
    case 'kt':
    case 'kts': return 'kotlin';
    case 'swift': return 'swift';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'scala': return 'scala';
    case 'lua': return 'lua';
    case 'dockerfile': return 'dockerfile';
    case 'proto': return 'protobuf';
    case 'graphql':
    case 'gql': return 'graphql';
    default:
      if (mime === 'text/x-sh' || mime === 'application/x-sh') return 'bash';
      return 'plaintext';
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
