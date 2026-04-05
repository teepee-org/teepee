import { useEffect, useRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { AgentSlot } from './AgentSlot';
import { ComposeBox } from './ComposeBox';
import type { Message, Agent } from '../types';

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
  activeJobs: ActiveJob[];
  onSend: (text: string) => void;
}

export function ChatView({ topicId, topicName, messages, agents, activeJobs, onSend }: Props) {
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
      <ComposeBox agents={agents} onSend={onSend} />
    </div>
  );
}
