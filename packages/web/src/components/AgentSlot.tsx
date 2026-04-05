import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
}

export function AgentSlot({ agentName, status, streamContent, error }: Props) {
  const statusLabel: Record<string, string> = {
    queued: 'queued',
    running: 'thinking...',
    streaming: 'streaming...',
    done: 'done',
    failed: 'failed',
  };

  const statusIcon: Record<string, string> = {
    queued: '⏳',
    running: '🔄',
    streaming: '📡',
    done: '✅',
    failed: '❌',
  };

  return (
    <div className={`agent-slot ${status}`}>
      <div className="agent-slot-header">
        <span className="agent-slot-name">🤖 {agentName}</span>
        <span className={`agent-slot-status status-${status}`}>
          {statusIcon[status]} {statusLabel[status]}
        </span>
      </div>
      <div className="agent-slot-body">
        {status === 'failed' && error ? (
          <div className="agent-error">{error}</div>
        ) : streamContent ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamContent}</ReactMarkdown>
        ) : status === 'queued' || status === 'running' ? (
          <div className="agent-thinking">
            <span className="dots">...</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
