import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatView } from './ChatView';
import { fetchMessageArtifacts } from '../api';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    fetchMessageArtifacts: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./ArtifactViewer', () => ({
  ArtifactViewer: ({ artifactId, versionNumber }: { artifactId: number; versionNumber?: number }) => (
    <div data-testid="artifact-viewer">
      artifact:{artifactId}:{versionNumber ?? 'current'}
    </div>
  ),
}));

vi.mock('./ReferenceViewer', () => ({
  ReferenceViewer: ({ href }: { href: string }) => (
    <div data-testid="reference-viewer">{href}</div>
  ),
}));

vi.mock('./TopicArtifactList', () => ({
  TopicArtifactList: () => null,
}));

vi.mock('./ComposeBox', () => ({
  ComposeBox: () => null,
}));

vi.mock('./JobInputCard', () => ({
  JobInputCard: () => null,
}));

vi.mock('./AgentSlot', () => ({
  AgentSlot: () => null,
}));

const baseProps = {
  topicId: 1,
  topicName: 'Links',
  agents: [],
  commands: [],
  activeJobs: [],
  inputRequests: [],
  currentUserId: 'usr_owner',
  onSend: vi.fn(),
  onAnswerInput: vi.fn(),
  onCancelInput: vi.fn(),
  projectPath: '/workspace',
};

describe('ChatView link routing', () => {
  beforeEach(() => {
    vi.mocked(fetchMessageArtifacts).mockClear();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('opens workspace references in the reference viewer', async () => {
    render(
      <ChatView
        {...baseProps}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: '[workspace doc](teepee:/workspace/BRAND_STATUS.md)',
            created_at: '2026-04-11T10:00:00.000Z',
          },
        ]}
      />
    );

    fireEvent.click(screen.getByText('workspace doc'));

    await waitFor(() =>
      expect(screen.getByTestId('reference-viewer').textContent).toBe('teepee:/workspace/BRAND_STATUS.md')
    );
  });

  it('opens artifact references in the artifact viewer using the canonical parser', async () => {
    render(
      <ChatView
        {...baseProps}
        messages={[
          {
            id: 2,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: '[artifact doc](teepee:/artifact/4#v2)',
            created_at: '2026-04-11T10:00:00.000Z',
          },
        ]}
      />
    );

    fireEvent.click(screen.getByText('artifact doc'));

    await waitFor(() =>
      expect(screen.getByTestId('artifact-viewer').textContent).toBe('artifact:4:2')
    );
  });

  it('opens filesystem references in the reference viewer', async () => {
    render(
      <ChatView
        {...baseProps}
        messages={[
          {
            id: 3,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: '[hosts](teepee:/fs/host/etc/hosts)',
            created_at: '2026-04-11T10:00:00.000Z',
          },
        ]}
      />
    );

    fireEvent.click(screen.getByText('hosts'));

    await waitFor(() =>
      expect(screen.getByTestId('reference-viewer').textContent).toBe('teepee:/fs/host/etc/hosts')
    );
  });
});
