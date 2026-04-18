import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
  phase?: string;
  projectPath?: string;
  onOpenReference?: (href: string) => void;
}

export function AgentSlot({ agentName, status, streamContent, error, phase, projectPath, onOpenReference }: Props) {
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
      {phase && (status === 'running' || status === 'queued') && !streamContent && (
        <div className="agent-slot-phase">{phase}</div>
      )}
      <div className="agent-slot-body">
        {status === 'failed' && error ? (
          <div className="agent-error">{error}</div>
        ) : streamContent ? (
          <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>{streamContent}</MarkdownRenderer>
        ) : status === 'queued' || status === 'running' ? (
          <div className="agent-thinking">
            <span className="dots">...</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
