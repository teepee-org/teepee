import { artifactDownloadUrl, type MessageArtifactInfo } from '../api';

interface Props {
  artifact: MessageArtifactInfo;
  onOpen: (artifactId: number, versionId: number) => void;
}

export function ArtifactCard({ artifact, onOpen }: Props) {
  const kindLabel = artifact.kind.charAt(0).toUpperCase() + artifact.kind.slice(1);
  const handleCopy = async () => {
    try {
      const res = await fetch(artifactDownloadUrl(artifact.artifact_id, artifact.artifact_version_id));
      const text = await res.text();
      await navigator.clipboard.writeText(text);
    } catch {}
  };

  return (
    <div className="artifact-card" onClick={() => onOpen(artifact.artifact_id, artifact.artifact_version_id)}>
      <div className="artifact-card-title">{artifact.title}</div>
      <div className="artifact-card-meta">
        {kindLabel} · Markdown · v{artifact.version}
      </div>
      <div className="artifact-card-actions">
        <button onClick={(e) => { e.stopPropagation(); onOpen(artifact.artifact_id, artifact.artifact_version_id); }}>
          Open
        </button>
        <button onClick={(e) => { e.stopPropagation(); handleCopy(); }}>
          Copy
        </button>
        <a
          href={artifactDownloadUrl(artifact.artifact_id, artifact.artifact_version_id)}
          download
          onClick={(e) => e.stopPropagation()}
        >
          Download
        </a>
      </div>
    </div>
  );
}
