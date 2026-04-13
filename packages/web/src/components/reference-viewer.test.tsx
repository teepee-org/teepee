import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ReferenceViewer } from './ReferenceViewer';
import {
  resolveReference,
  fetchFileAtRoot,
  fetchWorkspaceFile,
  fileDownloadUrl,
  workspaceDownloadUrl,
} from '../api';

vi.mock('../api', () => ({
  resolveReference: vi.fn(),
  fetchFileAtRoot: vi.fn(),
  fetchWorkspaceFile: vi.fn(),
  fetchArtifact: vi.fn(),
  fetchArtifactVersion: vi.fn(),
  fetchArtifactVersions: vi.fn(),
  fileDownloadUrl: vi.fn((rootId: string, filePath: string, disposition: 'attachment' | 'inline' = 'attachment') =>
    `/api/fs/download?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(filePath)}&disposition=${disposition}`),
  workspaceDownloadUrl: vi.fn((filePath: string, disposition: 'attachment' | 'inline' = 'attachment') =>
    `/api/workspace/download?path=${encodeURIComponent(filePath)}&disposition=${disposition}`),
  artifactDownloadUrl: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(resolveReference).mockReset();
  vi.mocked(fetchFileAtRoot).mockReset();
  vi.mocked(fetchWorkspaceFile).mockReset();
  vi.mocked(fileDownloadUrl).mockClear();
  vi.mocked(workspaceDownloadUrl).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ReferenceViewer', () => {
  it('renders a workspace text file without crashing', async () => {
    vi.mocked(resolveReference).mockResolvedValue({
      targetType: 'workspace-file',
      canonicalUri: 'teepee:/workspace/src/index.ts#L2',
      displayName: 'index.ts',
      mime: 'text/typescript',
      language: 'typescript',
      selection: { line: 2, column: null },
      fetch: { kind: 'workspace', path: 'src/index.ts' },
    });
    vi.mocked(fetchWorkspaceFile).mockResolvedValue({
      content: 'const a = 1;\nconst b = 2;',
      mime: 'text/typescript',
      size: 26,
    });

    render(
      <ReferenceViewer
        href="teepee:/workspace/src/index.ts#L2"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('index.ts')).toBeTruthy());
    const firstLine = document.querySelector('.code-line[data-line="1"] .code-line-content');
    const secondLine = document.querySelector('.code-line[data-line="2"] .code-line-content');
    expect(firstLine?.textContent).toBe('const a = 1;');
    expect(secondLine?.textContent).toBe('const b = 2;');
    const highlighted = document.querySelector('.reference-viewer-code .hljs-keyword');
    expect(highlighted).toBeTruthy();
    expect(screen.getByText('Copy ref')).toBeTruthy();
    expect(workspaceDownloadUrl).toHaveBeenCalledWith('src/index.ts', 'attachment');
  });
});
