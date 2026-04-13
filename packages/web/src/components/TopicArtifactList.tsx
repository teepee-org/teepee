import { useState, useEffect } from 'react';
import { fetchTopicArtifacts, type ArtifactSummary } from '../api';

interface Props {
  topicId: number;
  refreshKey?: number;
  onOpenArtifact: (artifactId: number, currentVersionId: number) => void;
}

export function TopicArtifactList({ topicId, refreshKey = 0, onOpenArtifact }: Props) {
  const [localArtifacts, setLocalArtifacts] = useState<ArtifactSummary[]>([]);
  const [inheritedArtifacts, setInheritedArtifacts] = useState<ArtifactSummary[]>([]);
  const [showInherited, setShowInherited] = useState(false);

  useEffect(() => {
    setShowInherited(false);
  }, [topicId]);

  useEffect(() => {
    fetchTopicArtifacts(topicId, 'inherited')
      .then((all) => {
        setLocalArtifacts(all.filter((artifact) => artifact.topic_id === topicId));
        setInheritedArtifacts(all.filter((artifact) => artifact.topic_id !== topicId));
      })
      .catch(() => {
        setLocalArtifacts([]);
        setInheritedArtifacts([]);
      });
  }, [topicId, refreshKey]);

  if (localArtifacts.length === 0 && inheritedArtifacts.length === 0) return null;

  return (
    <div className="topic-artifacts-panel">
      <ul className="topic-artifacts-list">
        {localArtifacts.map((artifact) => (
          <li
            key={artifact.id}
            className="topic-artifact-item"
            onClick={() => artifact.current_version_id && onOpenArtifact(artifact.id, artifact.current_version_id)}
          >
            <span className="topic-artifact-title">{artifact.title}</span>
            <span className="topic-artifact-meta">
              {artifact.kind}{artifact.canonical_source === 'repo' ? ' · promoted' : ''}
            </span>
          </li>
        ))}

        {showInherited && inheritedArtifacts.map((artifact) => (
          <li
            key={artifact.id}
            className="topic-artifact-item inherited"
            onClick={() => artifact.current_version_id && onOpenArtifact(artifact.id, artifact.current_version_id)}
          >
            <span className="topic-artifact-title">{artifact.title}</span>
            <span className="topic-artifact-meta">
              {artifact.kind}{artifact.canonical_source === 'repo' ? ' · promoted' : ''}
            </span>
          </li>
        ))}

        {inheritedArtifacts.length > 0 && (
          <li className="topic-artifact-toggle-slot">
            <button
              type="button"
              className="topic-artifact-toggle"
              onClick={() => setShowInherited((value) => !value)}
            >
              {showInherited ? 'Hide parents' : `+${inheritedArtifacts.length} parents`}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
