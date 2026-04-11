import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { JobInputCard } from './JobInputCard';
import type { PendingInputRequest } from '../api';

afterEach(() => {
  cleanup();
});

function makeRequest(overrides?: Partial<PendingInputRequest>): PendingInputRequest {
  return {
    requestId: 7,
    jobId: 11,
    topicId: 3,
    agentName: 'coder',
    requestedByUserId: 'usr_owner',
    requestedByHandle: 'owner',
    requestedByMessageId: 21,
    requestKey: 'approval',
    status: 'pending',
    title: 'Approval needed',
    kind: 'confirm',
    prompt: 'Proceed with deploy?',
    required: true,
    allowComment: true,
    answeredByUserId: null,
    answeredByHandle: null,
    answeredAt: null,
    expiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('JobInputCard', () => {
  it('lets the requester submit an answer with an optional comment', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(
      <JobInputCard
        request={makeRequest()}
        currentUserId="usr_owner"
        canCancel={true}
        onAnswer={onAnswer}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByLabelText('Rifiuta'));
    fireEvent.change(screen.getByPlaceholderText('Commento opzionale'), { target: { value: 'non ancora' } });
    fireEvent.click(screen.getByText('Invia risposta'));

    await waitFor(() => {
      expect(onAnswer).toHaveBeenCalledWith(7, { value: false, comment: 'non ancora' });
    });
  });

  it('shows a readonly notice to non-requesters instead of the answer form', () => {
    render(
      <JobInputCard
        request={makeRequest()}
        currentUserId="usr_other"
        canCancel={false}
        onAnswer={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText('Solo il requester puo rispondere a questa richiesta.')).toBeTruthy();
    expect(screen.queryByText('Invia risposta')).toBeNull();
  });

  it('renders the cancel action and forwards the request id', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);

    render(
      <JobInputCard
        request={makeRequest()}
        currentUserId="usr_owner"
        canCancel={true}
        onAnswer={vi.fn().mockResolvedValue(undefined)}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByText('Cancel request'));

    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith(7);
    });
  });
});
