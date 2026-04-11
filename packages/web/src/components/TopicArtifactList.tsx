import { useState, useEffect } from 'react';
import { fetchTopicArtifacts, type ArtifactSummary } from '../api';

interface Props {
  topicId: number;
  refreshKey?: number;
  onOpenArtifact: (artifactId: number, currentVersionId: number) => void;
}

export function TopicArtifactList({ topicId, refreshKey = 0, onOpenArtifact }: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([]);

  useEffect(() => {
    fetchTopicArtifacts(topicId).then(setArtifacts).catch(() => setArtifacts([]));
  }, [topicId, refreshKey]);

  if (artifacts.length === 0) return null;

  return (
    <div className="topic-artifacts-panel">
      <h3>Documents</h3>
      <ul className="topic-artifacts-list">
        {artifacts.map((a) => (
          <li
            key={a.id}
            className="topic-artifact-item"
            onClick={() => a.current_version_id && onOpenArtifact(a.id, a.current_version_id)}
          >
            <span className="topic-artifact-title">{a.title}</span>
            <span className="topic-artifact-meta">
              {a.kind}{a.canonical_source === 'repo' ? ' · promoted' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
