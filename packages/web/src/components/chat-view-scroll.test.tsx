import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatView } from './ChatView';

vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { id: number | string; body: string } }) => (
    <div data-message-id={message.id}>{message.body}</div>
  ),
}));

vi.mock('./ArtifactViewer', () => ({
  ArtifactViewer: () => null,
}));

vi.mock('./ReferenceViewer', () => ({
  ReferenceViewer: () => null,
}));

vi.mock('./TopicArtifactList', () => ({
  TopicArtifactList: () => null,
}));

vi.mock('./JobInputCard', () => ({
  JobInputCard: () => null,
}));

vi.mock('./AgentSlot', () => ({
  AgentSlot: ({ agentName }: { agentName: string }) => <div>{agentName} thinking</div>,
}));

vi.mock('./ComposeBox', () => ({
  ComposeBox: ({ onSend }: { onSend: (text: string) => boolean }) => (
    <button onClick={() => onSend('@architect ping')}>send</button>
  ),
}));

const baseProps = {
  topicId: 1,
  topicName: 'Scroll',
  agents: [],
  commands: [],
  inputRequests: [],
  currentUserId: 'usr_owner',
  onAnswerInput: vi.fn(),
  onCancelInput: vi.fn(),
  projectPath: '/workspace',
};

function setScrollMetrics(el: HTMLDivElement, scrollHeight: number, clientHeight: number, scrollTop: number) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  el.scrollTop = scrollTop;
}

describe('ChatView sticky bottom scroll', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the panel pinned to bottom after a local send when the thinking slot appears', () => {
    const onSend = vi.fn(() => true);
    const { container, rerender } = render(
      <ChatView
        {...baseProps}
        onSend={onSend}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: 'hello',
            created_at: '2026-04-12T10:00:00.000Z',
          },
        ]}
        activeJobs={[]}
      />
    );

    const messagesEl = container.querySelector('.chat-messages') as HTMLDivElement;
    setScrollMetrics(messagesEl, 1000, 400, 120);
    fireEvent.scroll(messagesEl);

    fireEvent.click(screen.getByText('send'));
    expect(onSend).toHaveBeenCalledWith('@architect ping');

    setScrollMetrics(messagesEl, 1320, 400, messagesEl.scrollTop);
    rerender(
      <ChatView
        {...baseProps}
        onSend={onSend}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: 'hello',
            created_at: '2026-04-12T10:00:00.000Z',
          },
          {
            id: 2,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: '@architect ping',
            created_at: '2026-04-12T10:00:01.000Z',
          },
        ]}
        activeJobs={[
          {
            jobId: 99,
            agentName: 'architect',
            status: 'running',
            streamContent: '',
          },
        ]}
      />
    );

    expect(messagesEl.scrollTop).toBe(1320);
  });

  it('does not jump to bottom for passive updates when the user scrolled away', () => {
    const onSend = vi.fn(() => true);
    const { container, rerender } = render(
      <ChatView
        {...baseProps}
        onSend={onSend}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: 'hello',
            created_at: '2026-04-12T10:00:00.000Z',
          },
        ]}
        activeJobs={[]}
      />
    );

    const messagesEl = container.querySelector('.chat-messages') as HTMLDivElement;
    setScrollMetrics(messagesEl, 1000, 400, 120);
    fireEvent.scroll(messagesEl);

    setScrollMetrics(messagesEl, 1320, 400, 120);
    rerender(
      <ChatView
        {...baseProps}
        onSend={onSend}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: 'hello',
            created_at: '2026-04-12T10:00:00.000Z',
          },
          {
            id: 3,
            topic_id: 1,
            author_type: 'agent',
            author_name: 'architect',
            body: 'remote update',
            created_at: '2026-04-12T10:00:01.000Z',
          },
        ]}
        activeJobs={[]}
      />
    );

    expect(messagesEl.scrollTop).toBe(120);
  });

  it('pins to bottom when switching to another topic without a highlighted target', () => {
    const onSend = vi.fn(() => true);
    const { container, rerender } = render(
      <ChatView
        {...baseProps}
        topicId={1}
        topicName="Topic 1"
        onSend={onSend}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: 'older topic message',
            created_at: '2026-04-12T10:00:00.000Z',
          },
        ]}
        activeJobs={[]}
      />
    );

    const messagesEl = container.querySelector('.chat-messages') as HTMLDivElement;
    setScrollMetrics(messagesEl, 1000, 400, 120);
    fireEvent.scroll(messagesEl);

    setScrollMetrics(messagesEl, 1400, 400, 120);
    rerender(
      <ChatView
        {...baseProps}
        topicId={2}
        topicName="Topic 2"
        onSend={onSend}
        messages={[
          {
            id: 10,
            topic_id: 2,
            author_type: 'user',
            author_name: 'owner',
            body: 'new topic latest message',
            created_at: '2026-04-12T10:01:00.000Z',
          },
        ]}
        activeJobs={[
          {
            jobId: 100,
            agentName: 'architect',
            status: 'running',
            streamContent: '',
          },
        ]}
      />
    );

    expect(messagesEl.scrollTop).toBe(1400);
  });

  it('does not pin to bottom when opening a topic around a highlighted message', () => {
    const onSend = vi.fn(() => true);
    const { container, rerender } = render(
      <ChatView
        {...baseProps}
        topicId={1}
        topicName="Topic 1"
        onSend={onSend}
        messages={[
          {
            id: 1,
            topic_id: 1,
            author_type: 'user',
            author_name: 'owner',
            body: 'older topic message',
            created_at: '2026-04-12T10:00:00.000Z',
          },
        ]}
        activeJobs={[]}
      />
    );

    const messagesEl = container.querySelector('.chat-messages') as HTMLDivElement;
    setScrollMetrics(messagesEl, 1000, 400, 120);
    fireEvent.scroll(messagesEl);

    setScrollMetrics(messagesEl, 1400, 400, 120);
    rerender(
      <ChatView
        {...baseProps}
        topicId={2}
        topicName="Topic 2"
        highlightedMessageId={25}
        onSend={onSend}
        messages={[
          {
            id: 25,
            topic_id: 2,
            author_type: 'user',
            author_name: 'owner',
            body: 'target message',
            created_at: '2026-04-12T10:01:00.000Z',
          },
        ]}
        activeJobs={[]}
      />
    );

    expect(messagesEl.scrollTop).toBe(120);
  });
});
