import { useEffect, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { activityToString } from '../App';

interface AgentActivity {
  kind: 'tool_use' | 'shell' | 'text_delta';
  tool?: string;
  target?: string;
  command?: string;
  preview?: string;
  at: number;
}

interface Props {
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
  phase?: string;
  lastActivity?: AgentActivity;
  projectPath?: string;
  onOpenReference?: (href: string) => void;
}

/** Fade the activity label after this many ms of silence (no new event). */
const ACTIVITY_STALE_MS = 5_000;

export function AgentSlot({ agentName, status, streamContent, error, phase, lastActivity, projectPath, onOpenReference }: Props) {
  // Re-render when an activity goes stale so the line can fade.
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!lastActivity) return;
    const id = window.setTimeout(() => forceUpdate((n) => n + 1), ACTIVITY_STALE_MS + 50);
    return () => window.clearTimeout(id);
  }, [lastActivity?.at]);

  const activityStale = lastActivity ? Date.now() - lastActivity.at > ACTIVITY_STALE_MS : true;
  const activityLine = lastActivity && !activityStale ? activityToString(lastActivity) : null;

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

  const alive = status === 'running' || status === 'streaming' || status === 'queued';

  return (
    <div className={`agent-slot ${status}`}>
      <div className="agent-slot-header">
        <span className="agent-slot-name">
          🤖 {agentName}
          {alive && <span className="agent-slot-live-dot" aria-hidden="true" />}
        </span>
        <span className={`agent-slot-status status-${status}`}>
          {statusIcon[status]} {statusLabel[status]}
        </span>
      </div>
      {activityLine && (status === 'running' || status === 'streaming') && (
        <div className="agent-slot-activity">{activityLine}</div>
      )}
      {phase && (status === 'running' || status === 'queued') && !streamContent && !activityLine && (
        <div className="agent-slot-phase">{phase}</div>
      )}
      <div className="agent-slot-body">
        {status === 'failed' && error ? (
          <div className="agent-error">{error}</div>
        ) : streamContent ? (
          <>
            <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>{streamContent}</MarkdownRenderer>
            {alive && <span className="agent-slot-cursor" aria-hidden="true" />}
          </>
        ) : status === 'queued' || status === 'running' ? (
          <div className="agent-thinking">
            <span className="dots">...</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
