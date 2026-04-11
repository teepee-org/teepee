import { useState, useEffect } from 'react';
import type { Message } from '../types';
import { fetchMessageArtifacts, type MessageArtifactInfo } from '../api';
import { ArtifactCard } from './ArtifactCard';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  message: Message;
  highlighted?: boolean;
  onOpenArtifact?: (artifactId: number, versionId: number) => void;
  projectPath?: string;
  onOpenReference?: (href: string) => void;
}

export function MessageBubble({ message, highlighted = false, onOpenArtifact, projectPath, onOpenReference }: Props) {
  const [showRaw, setShowRaw] = useState(false);
  const [artifacts, setArtifacts] = useState<MessageArtifactInfo[]>([]);
  const isSystem = message.author_type === 'system';
  const isAgent = message.author_type === 'agent';
  const isRichSystem = isSystem && message.body.includes('\n');

  useEffect(() => {
    if (isAgent && message.id > 0) {
      fetchMessageArtifacts(message.id).then(setArtifacts).catch(() => {});
    }
  }, [message.id, isAgent]);

  return (
    <div
      className={`message ${message.author_type}${isRichSystem ? ' system-rich' : ''}${highlighted ? ' highlighted' : ''}`}
      data-message-id={message.id}
    >
      <div className="message-header">
        <span className={`author ${message.author_type}`}>
          {isAgent && '🤖 '}
          {isSystem && '⚙️ '}
          {message.author_name}
        </span>
        <span className="timestamp">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
        {!isSystem && (
          <button
            className="raw-toggle"
            onClick={() => setShowRaw(!showRaw)}
            title={showRaw ? 'Rendered view' : 'Raw view'}
          >
            {showRaw ? '📄' : '</>'}
          </button>
        )}
      </div>
      <div className="message-body">
        {showRaw || (isSystem && !isRichSystem) ? (
          <pre className="raw">{message.body}</pre>
        ) : (
          <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>
            {message.body}
          </MarkdownRenderer>
        )}
      </div>
      {artifacts.length > 0 && (
        <div className="message-artifacts">
          {artifacts.map((a) => (
            <ArtifactCard
              key={`${a.artifact_id}-${a.artifact_version_id}`}
              artifact={a}
              onOpen={onOpenArtifact ?? (() => {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}
