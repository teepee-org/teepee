import { useState, useEffect } from 'react';
import {
  fetchArtifact,
  fetchArtifactVersions,
  fetchArtifactVersion,
  promoteArtifactVersion,
  artifactDownloadUrl,
  type ArtifactSummary,
  type ArtifactVersion,
} from '../api';
import { MarkdownRenderer } from './MarkdownRenderer';

interface Props {
  artifactId: number;
  versionId: number;
  versionNumber?: number;
  canPromote: boolean;
  onClose: () => void;
  projectPath?: string;
  onOpenReference?: (href: string) => void;
}

export function ArtifactViewer({ artifactId, versionId, versionNumber, canPromote, onClose, projectPath, onOpenReference }: Props) {
  const [artifact, setArtifact] = useState<ArtifactSummary | null>(null);
  const [version, setVersion] = useState<ArtifactVersion | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [activeTab, setActiveTab] = useState<'content' | 'versions'>('content');
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoadError(null);
        const a = await fetchArtifact(artifactId);
        if (cancelled) return;
        setArtifact(a);

        const vs = await fetchArtifactVersions(artifactId);
        if (cancelled) return;
        setVersions(vs);

        if (versionNumber !== undefined) {
          const match = vs.find((v) => v.version === versionNumber);
          if (!match) {
            setLoadError(`Artifact version v${versionNumber} not found`);
            setVersion(null);
            return;
          }
          setVersion(match);
          return;
        }

        const vid = versionId || a.current_version_id;
        if (!vid) {
          setLoadError('Artifact has no versions');
          setVersion(null);
          return;
        }
        const current = await fetchArtifactVersion(artifactId, vid);
        if (cancelled) return;
        setVersion(current);
      } catch (e: any) {
        if (!cancelled) {
          setLoadError(e.message || 'Failed to load artifact');
          setVersion(null);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [artifactId, versionId, versionNumber]);

  const handlePromote = async () => {
    if (!artifact || !version) return;
    const repoPath = prompt(`Promote to repo path (must start with doc/, docs/, or spec/):`, `docs/${artifact.kind}/${artifact.title.replace(/\s+/g, '-').toLowerCase()}.md`);
    if (!repoPath) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const result = await promoteArtifactVersion(artifactId, version.id, repoPath);
      if (result.ok) {
        fetchArtifact(artifactId).then(setArtifact);
      } else {
        setPromoteError(result.error || 'Promote failed');
      }
    } catch (e: any) {
      setPromoteError(e.message);
    } finally {
      setPromoting(false);
    }
  };

  const handleCopy = async () => {
    if (version) {
      await navigator.clipboard.writeText(version.body);
    }
  };

  const switchVersion = (v: ArtifactVersion) => {
    setVersion(v);
    setActiveTab('content');
  };

  if (loadError) {
    return (
      <div className="artifact-viewer">
        <div className="artifact-viewer-header">
          <button onClick={onClose}>Close</button>
        </div>
        <div className="artifact-viewer-body">{loadError}</div>
      </div>
    );
  }

  if (!artifact || !version) {
    return (
      <div className="artifact-viewer">
        <div className="artifact-viewer-header">
          <button onClick={onClose}>Close</button>
        </div>
        <div className="artifact-viewer-body">Loading...</div>
      </div>
    );
  }

  return (
    <div className="artifact-viewer">
      <div className="artifact-viewer-header">
        <div className="artifact-viewer-title">
          <h2>{artifact.title}</h2>
          <span className="artifact-viewer-meta">
            {artifact.kind} · v{version.version} · {artifact.status}
            {artifact.canonical_source === 'repo' && ' · promoted'}
          </span>
        </div>
        <div className="artifact-viewer-actions">
          <button onClick={handleCopy}>Copy</button>
          <a href={artifactDownloadUrl(artifactId, version.id)} download>Download</a>
          {canPromote && (
            <button onClick={handlePromote} disabled={promoting}>
              {promoting ? 'Promoting...' : 'Promote to repo'}
            </button>
          )}
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      {promoteError && <div className="artifact-viewer-error">{promoteError}</div>}
      <div className="artifact-viewer-tabs">
        <button className={activeTab === 'content' ? 'active' : ''} onClick={() => setActiveTab('content')}>
          Content
        </button>
        <button className={activeTab === 'versions' ? 'active' : ''} onClick={() => setActiveTab('versions')}>
          Versions ({versions.length})
        </button>
      </div>
      <div className="artifact-viewer-body">
        {activeTab === 'content' ? (
          <div className="artifact-viewer-markdown">
            <MarkdownRenderer projectPath={projectPath} onOpenReference={onOpenReference}>{version.body}</MarkdownRenderer>
          </div>
        ) : (
          <div className="artifact-viewer-versions">
            {versions.map((v) => (
              <div
                key={v.id}
                className={`artifact-version-item ${v.id === version.id ? 'active' : ''}`}
                onClick={() => switchVersion(v)}
              >
                <span className="version-number">v{v.version}</span>
                <span className="version-agent">{v.created_by_agent || 'unknown'}</span>
                <span className="version-date">{new Date(v.created_at).toLocaleString()}</span>
                {v.summary && <span className="version-summary">{v.summary}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
