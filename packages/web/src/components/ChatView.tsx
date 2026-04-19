import { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { MessageBubble } from './MessageBubble';
import { AgentSlot } from './AgentSlot';
import { ComposeBox } from './ComposeBox';
import { ArtifactViewer } from './ArtifactViewer';
import { ReferenceViewer } from './ReferenceViewer';
import { TopicArtifactList } from './TopicArtifactList';
import { JobInputCard } from './JobInputCard';
import type { Message, Agent } from '../types';
import type { CommandDef } from '../buildHelpMarkdown';
import type { PendingInputRequest } from '../api';
import { parseTeepeeUri } from '../teepee-uri';

interface AgentActivity {
  kind: 'tool_use' | 'shell' | 'text_delta';
  tool?: string;
  target?: string;
  command?: string;
  preview?: string;
  at: number;
}

interface ActiveJob {
  jobId: number;
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
  phase?: string;
  round?: number;
  lastActivity?: AgentActivity;
  timedOut?: boolean;
}

interface Props {
  topicId: number;
  topicName: string;
  messages: Message[];
  agents: Agent[];
  commands: CommandDef[];
  activeJobs: ActiveJob[];
  inputRequests: PendingInputRequest[];
  currentUserId: string | null;
  onSend: (text: string) => boolean;
  onAnswerInput: (requestId: number, payload: { value: boolean | string | string[]; comment?: string }) => Promise<void>;
  onCancelInput: (requestId: number) => Promise<void>;
  onMenuToggle?: () => void;
  highlightedMessageId?: number | null;
  canCancelAnyInputRequest?: boolean;
  canPromoteArtifacts?: boolean;
  projectPath?: string;
}

export function ChatView({
  topicId,
  topicName,
  messages,
  agents,
  commands,
  activeJobs,
  inputRequests,
  currentUserId,
  onSend,
  onAnswerInput,
  onCancelInput,
  onMenuToggle,
  highlightedMessageId,
  canCancelAnyInputRequest = false,
  canPromoteArtifacts = false,
  projectPath,
}: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);
  const stickToBottom = useRef(true);
  const [openArtifact, setOpenArtifact] = useState<{ artifactId: number; versionId: number; versionNumber?: number } | null>(null);
  const [openRef, setOpenRef] = useState<string | null>(null);
  const visibleInputRequests = inputRequests.filter((request) => request.status === 'pending');

  const handleOpenReference = useCallback((href: string) => {
    const parsed = parseTeepeeUri(href);
    if (parsed?.namespace === 'artifact') {
      const artifactId = parseInt(parsed.resource, 10);
      if (!Number.isNaN(artifactId)) {
        setOpenArtifact({ artifactId, versionId: 0, versionNumber: parsed.artifactVersion });
        return;
      }
    }
    setOpenRef(href);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, []);

  // Track if user is at bottom
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    isAtBottom.current = nearBottom;
    stickToBottom.current = nearBottom;
  };

  const handleSend = useCallback((text: string) => {
    const wasAtBottom = isAtBottom.current;
    const wasSticky = stickToBottom.current;
    isAtBottom.current = true;
    stickToBottom.current = true;
    const accepted = onSend(text);
    if (!accepted) {
      isAtBottom.current = wasAtBottom;
      stickToBottom.current = wasSticky;
    }
    return accepted;
  }, [onSend]);

  useLayoutEffect(() => {
    if (highlightedMessageId) {
      isAtBottom.current = false;
      stickToBottom.current = false;
      return;
    }
    isAtBottom.current = true;
    stickToBottom.current = true;
    scrollToBottom();
  }, [topicId, highlightedMessageId, scrollToBottom]);

  // Keep following the bottom after local sends until the user scrolls away.
  useLayoutEffect(() => {
    if (stickToBottom.current) {
      scrollToBottom();
    }
  }, [messages, activeJobs, visibleInputRequests.length, scrollToBottom]);

  useEffect(() => {
    if (!highlightedMessageId) return;
    const target = containerRef.current?.querySelector(`[data-message-id="${highlightedMessageId}"]`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightedMessageId, messages]);

  if (openRef) {
    return (
      <div className="chat-view">
        <ReferenceViewer
          href={openRef}
          projectPath={projectPath}
          onClose={() => setOpenRef(null)}
          onOpenReference={handleOpenReference}
        />
      </div>
    );
  }

  if (openArtifact) {
    return (
      <div className="chat-view">
        <ArtifactViewer
          artifactId={openArtifact.artifactId}
          versionId={openArtifact.versionId}
          versionNumber={openArtifact.versionNumber}
          canPromote={canPromoteArtifacts}
          onClose={() => setOpenArtifact(null)}
          projectPath={projectPath}
          onOpenReference={handleOpenReference}
        />
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="chat-header">
        {onMenuToggle && (
          <button className="mobile-menu-btn" onClick={onMenuToggle} aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
              <rect y="3" width="20" height="2" rx="1"/>
              <rect y="9" width="20" height="2" rx="1"/>
              <rect y="15" width="20" height="2" rx="1"/>
            </svg>
          </button>
        )}
        <h2>{topicName} <span className="topic-id">#{topicId}</span></h2>
      </div>
      <TopicArtifactList
        topicId={topicId}
        refreshKey={messages.length}
        onOpenArtifact={(aId, vId) => setOpenArtifact({ artifactId: aId, versionId: vId })}
      />
      <div
        className="chat-messages"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            highlighted={msg.id === highlightedMessageId}
            onOpenArtifact={(aId, vId) => setOpenArtifact({ artifactId: aId, versionId: vId })}
            projectPath={projectPath}
            onOpenReference={handleOpenReference}
          />
        ))}
        {visibleInputRequests.map((request) => (
          <JobInputCard
            key={request.requestId}
            request={request}
            currentUserId={currentUserId}
            canCancel={canCancelAnyInputRequest || currentUserId === request.requestedByUserId}
            onAnswer={onAnswerInput}
            onCancel={onCancelInput}
          />
        ))}
        {activeJobs.filter((j) => j.status !== 'done').map((job) => (
          <AgentSlot
            key={job.jobId}
            agentName={job.agentName}
            status={job.status}
            streamContent={job.streamContent}
            error={job.error}
            phase={job.phase}
            lastActivity={job.lastActivity}
            projectPath={projectPath}
            onOpenReference={handleOpenReference}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <ComposeBox topicId={topicId} agents={agents} commands={commands} onSend={handleSend} />
    </div>
  );
}
