import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { AgentSlot } from './AgentSlot';
import { ComposeBox } from './ComposeBox';
import type { Message, Agent } from '../types';
import type { CommandDef } from '../buildHelpMarkdown';

interface ActiveJob {
  jobId: number;
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
}

interface Props {
  topicId: number;
  topicName: string;
  messages: Message[];
  agents: Agent[];
  commands: CommandDef[];
  activeJobs: ActiveJob[];
  onSend: (text: string) => void;
  onMenuToggle?: () => void;
}

export function ChatView({ topicId, topicName, messages, agents, commands, activeJobs, onSend, onMenuToggle }: Props) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef(true);

  // Track if user is at bottom
  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (isAtBottom.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, activeJobs]);

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
        <h2>#{topicId} {topicName}</h2>
      </div>
      <div
        className="chat-messages"
        ref={containerRef}
        onScroll={handleScroll}
      >
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {activeJobs.filter((j) => j.status !== 'done').map((job) => (
          <AgentSlot
            key={job.jobId}
            agentName={job.agentName}
            status={job.status}
            streamContent={job.streamContent}
            error={job.error}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>
      <ComposeBox agents={agents} commands={commands} onSend={onSend} />
    </div>
  );
}
