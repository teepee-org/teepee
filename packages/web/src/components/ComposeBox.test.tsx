import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { suggestReferences } from '../api';
import { ComposeBox, _resetHistoryForTests } from './ComposeBox';

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api');
  return {
    ...actual,
    suggestReferences: vi.fn().mockResolvedValue({ items: [] }),
  };
});

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

const AGENTS = [{ name: 'coder', provider: 'echo' }];
const COMMANDS = [
  { command: '/help', description: 'Show help' },
  { command: '/topic rename <name>', description: 'Rename topic' },
];

beforeEach(() => {
  _resetHistoryForTests();
  vi.mocked(suggestReferences).mockClear();
});

function renderCompose(topicId = 1, onSendReturn = true) {
  const onSend = vi.fn().mockReturnValue(onSendReturn);
  const result = render(
    <ComposeBox topicId={topicId} agents={AGENTS} commands={COMMANDS} onSend={onSend} />
  );
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  return { onSend, textarea, result };
}

function sendMessage(textarea: HTMLTextAreaElement, text: string) {
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: 'Enter' });
}

function arrowUp(textarea: HTMLTextAreaElement) {
  fireEvent.keyDown(textarea, { key: 'ArrowUp' });
}

function arrowDown(textarea: HTMLTextAreaElement) {
  fireEvent.keyDown(textarea, { key: 'ArrowDown' });
}

describe('compose history', () => {
  it('ArrowUp recalls the last sent message when composer is empty', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, 'hello world');
    expect(textarea.value).toBe('');

    arrowUp(textarea);
    expect(textarea.value).toBe('hello world');
  });

  it('ArrowUp/ArrowDown navigate through multiple entries', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, 'first');
    sendMessage(textarea, 'second');
    sendMessage(textarea, 'third');

    arrowUp(textarea); // third
    expect(textarea.value).toBe('third');

    arrowUp(textarea); // second
    expect(textarea.value).toBe('second');

    arrowUp(textarea); // first
    expect(textarea.value).toBe('first');

    // Can't go further back
    arrowUp(textarea);
    expect(textarea.value).toBe('first');

    arrowDown(textarea); // second
    expect(textarea.value).toBe('second');

    arrowDown(textarea); // third
    expect(textarea.value).toBe('third');
  });

  it('slash commands are included in history', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, '/help');
    sendMessage(textarea, 'normal message');

    arrowUp(textarea); // normal message
    arrowUp(textarea); // /help
    expect(textarea.value).toBe('/help');
  });

  it('ArrowDown past the end restores empty draft', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, 'msg');

    arrowUp(textarea);
    expect(textarea.value).toBe('msg');

    arrowDown(textarea); // past end → restore draft (empty)
    expect(textarea.value).toBe('');
  });

  it('does not add empty messages to history', () => {
    const { textarea, onSend } = renderCompose();
    // Try to send empty
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();

    sendMessage(textarea, 'real message');
    arrowUp(textarea);
    expect(textarea.value).toBe('real message');

    // Only one entry — ArrowUp again stays on same
    arrowUp(textarea);
    expect(textarea.value).toBe('real message');
  });

  it('ArrowUp does NOT start history navigation when composer has text', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, 'old message');

    // Type something in the composer
    fireEvent.change(textarea, { target: { value: 'current draft' } });

    arrowUp(textarea);
    // Should NOT recall history — text should remain unchanged
    expect(textarea.value).toBe('current draft');
  });

  it('history is per-topic', () => {
    const onSend = vi.fn().mockReturnValue(true);
    const { rerender } = render(
      <ComposeBox topicId={1} agents={AGENTS} commands={COMMANDS} onSend={onSend} />
    );
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    // Send messages in topic 1
    sendMessage(textarea, 'topic1 msg');

    // Switch to topic 2
    rerender(
      <ComposeBox topicId={2} agents={AGENTS} commands={COMMANDS} onSend={onSend} />
    );

    sendMessage(textarea, 'topic2 msg');

    // ArrowUp should recall topic 2's history, not topic 1's
    arrowUp(textarea);
    expect(textarea.value).toBe('topic2 msg');

    // No more history for topic 2
    arrowUp(textarea);
    expect(textarea.value).toBe('topic2 msg');

    // ArrowDown to exit history mode and restore empty
    arrowDown(textarea);
    expect(textarea.value).toBe('');

    // Switch back to topic 1
    rerender(
      <ComposeBox topicId={1} agents={AGENTS} commands={COMMANDS} onSend={onSend} />
    );

    arrowUp(textarea);
    expect(textarea.value).toBe('topic1 msg');
  });

  it('typing exits history mode', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, 'first');
    sendMessage(textarea, 'second');

    arrowUp(textarea); // second
    arrowUp(textarea); // first
    expect(textarea.value).toBe('first');

    // User types something — exits history mode
    fireEvent.change(textarea, { target: { value: 'new text' } });

    // ArrowUp should not navigate history since composer has text
    arrowUp(textarea);
    expect(textarea.value).toBe('new text');
  });

  it('does not interfere with autocomplete arrow navigation', () => {
    const { textarea } = renderCompose();
    sendMessage(textarea, 'old message');

    // Trigger command autocomplete by typing /
    fireEvent.change(textarea, { target: { value: '/' } });

    // ArrowDown should control autocomplete, not history
    arrowDown(textarea);
    // The composer value should still be / (autocomplete is open, not history)
    expect(textarea.value).toBe('/');
  });

  it('does not add rejected sends to history', () => {
    // onSend returns false (no-op / invalid command)
    const { textarea } = renderCompose(1, false);
    sendMessage(textarea, '/topic move');

    // History should be empty — the no-op was not stored
    arrowUp(textarea);
    expect(textarea.value).toBe('');
  });

  it('history survives component unmount and remount', () => {
    const onSend = vi.fn().mockReturnValue(true);
    const { unmount } = render(
      <ComposeBox topicId={1} agents={AGENTS} commands={COMMANDS} onSend={onSend} />
    );
    const textarea1 = screen.getByRole('textbox') as HTMLTextAreaElement;
    sendMessage(textarea1, 'before unmount');

    // Unmount (simulates switching to Admin view)
    unmount();

    // Remount
    render(
      <ComposeBox topicId={1} agents={AGENTS} commands={COMMANDS} onSend={onSend} />
    );
    const textarea2 = screen.getByRole('textbox') as HTMLTextAreaElement;

    arrowUp(textarea2);
    expect(textarea2.value).toBe('before unmount');
  });

  it('uses global reference scope when the query starts with !', async () => {
    const { textarea } = renderCompose();

    fireEvent.change(textarea, { target: { value: '[[!queue' } });

    await waitFor(() => {
      expect(vi.mocked(suggestReferences)).toHaveBeenCalledWith('queue', 1, 15, 'global');
    });
  });

  it('keeps reference autocomplete open when selecting a directory suggestion', async () => {
    vi.mocked(suggestReferences)
      .mockResolvedValueOnce({
        items: [
          {
            type: 'filesystem_dir',
            label: 'host/etc/',
            insertText: '[[/etc/',
            canonicalUri: 'teepee:/fs/host/etc/',
            description: 'host directory',
            continueAutocomplete: true,
          },
        ],
      })
      .mockResolvedValueOnce({ items: [] });

    const { textarea } = renderCompose();
    fireEvent.change(textarea, { target: { value: '[[/et' } });

    await waitFor(() => {
      expect(screen.getByText('host/etc/')).toBeTruthy();
    });

    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(textarea.value).toBe('[[/etc/');

    await waitFor(() => {
      expect(vi.mocked(suggestReferences)).toHaveBeenLastCalledWith('/etc/', 1, 15, 'inherited');
    });
  });
});
