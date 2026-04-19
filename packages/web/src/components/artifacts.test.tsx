import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ArtifactCard } from './ArtifactCard';
import { ArtifactViewer } from './ArtifactViewer';
import { TopicArtifactList } from './TopicArtifactList';
import {
  fetchArtifact,
  fetchArtifactVersion,
  fetchArtifactVersions,
  fetchTopicArtifacts,
} from '../api';

vi.mock('../api', () => ({
  artifactDownloadUrl: (artifactId: number, versionId: number) =>
    `/api/artifacts/${artifactId}/versions/${versionId}/download`,
  fetchArtifact: vi.fn(),
  fetchArtifactVersion: vi.fn(),
  fetchArtifactVersions: vi.fn(),
  fetchTopicArtifacts: vi.fn(),
  promoteArtifactVersion: vi.fn(),
}));

const artifactSummary = {
  id: 12,
  topic_id: 1,
  artifact_class: 'document',
  kind: 'plan',
  title: 'Queue UI rollout',
  status: 'draft',
  canonical_source: 'db',
  current_version_id: 101,
  created_by_agent: 'architect',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const versions = [
  {
    id: 100,
    artifact_id: 12,
    version: 1,
    content_type: 'text/markdown',
    body: '# First',
    summary: null,
    created_by_agent: 'architect',
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 101,
    artifact_id: 12,
    version: 2,
    content_type: 'text/markdown',
    body: '# Second',
    summary: null,
    created_by_agent: 'architect',
    created_at: '2026-01-02T00:00:00Z',
  },
];

beforeEach(() => {
  vi.mocked(fetchArtifact).mockReset();
  vi.mocked(fetchArtifactVersion).mockReset();
  vi.mocked(fetchArtifactVersions).mockReset();
  vi.mocked(fetchTopicArtifacts).mockReset();
});

afterEach(() => {
  cleanup();
});

describe('ArtifactCard', () => {
  it('renders artifact metadata and opens the document', () => {
    const onOpen = vi.fn();
    render(
      <ArtifactCard
        artifact={{
          artifact_id: 12,
          artifact_version_id: 101,
          relation: 'created',
          kind: 'plan',
          title: 'Queue UI rollout',
          version: 2,
        }}
        onOpen={onOpen}
      />
    );

    expect(screen.getByText('Queue UI rollout')).toBeTruthy();
    expect(screen.getByText('Plan · Markdown · v2')).toBeTruthy();
    expect(screen.getByText('Download').getAttribute('href')).toBe('/api/artifacts/12/versions/101/download');

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith(12, 101);
  });
});

describe('ArtifactViewer', () => {
  it('renders markdown, owner promote action, and versions tab', async () => {
    vi.mocked(fetchArtifact).mockResolvedValue(artifactSummary);
    vi.mocked(fetchArtifactVersion).mockResolvedValue(versions[1]);
    vi.mocked(fetchArtifactVersions).mockResolvedValue(versions);

    render(
      <ArtifactViewer
        artifactId={12}
        versionId={101}
        canPromote={true}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Queue UI rollout')).toBeTruthy());
    expect(screen.getByText('Second')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Promote to repo' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Versions (2)' }));
    expect(screen.getByText('v1')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();

    fireEvent.click(screen.getByText('v1'));
    expect(screen.getByText('First')).toBeTruthy();
  });

  it('fails explicitly when a requested version number does not exist', async () => {
    vi.mocked(fetchArtifact).mockResolvedValue(artifactSummary);
    vi.mocked(fetchArtifactVersions).mockResolvedValue(versions);

    render(
      <ArtifactViewer
        artifactId={12}
        versionId={0}
        versionNumber={999}
        canPromote={false}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText('Artifact version v999 not found')).toBeTruthy());
    expect(fetchArtifactVersion).not.toHaveBeenCalled();
  });
});

describe('TopicArtifactList', () => {
  it('reloads when refreshKey changes', async () => {
    vi.mocked(fetchTopicArtifacts)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([artifactSummary]);

    const { rerender } = render(
      <TopicArtifactList topicId={1} refreshKey={0} onOpenArtifact={vi.fn()} />
    );
    await waitFor(() => expect(fetchTopicArtifacts).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Queue UI rollout')).toBeNull();

    rerender(
      <TopicArtifactList topicId={1} refreshKey={1} onOpenArtifact={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByText('Queue UI rollout')).toBeTruthy());
    expect(fetchTopicArtifacts).toHaveBeenCalledTimes(2);
  });
});
