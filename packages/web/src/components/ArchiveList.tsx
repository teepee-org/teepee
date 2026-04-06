import type { Topic } from '../types';
import type { DividerResponse, SubjectResponse } from 'teepee-core';

interface Props {
  archivedTopics: Topic[];
  dividers: DividerResponse[];
  subjects: SubjectResponse[];
  onRestore: (topicId: number) => void;
  userRole: string;
}

export function ArchiveList({ archivedTopics, dividers, subjects, onRestore, userRole }: Props) {
  const canEdit = userRole !== 'observer';

  const getDividerName = (id: number | null) => {
    if (id == null) return null;
    return dividers.find((d) => d.id === id)?.name ?? null;
  };

  const getSubjectName = (id: number | null) => {
    if (id == null) return null;
    return subjects.find((s) => s.id === id)?.name ?? null;
  };

  if (archivedTopics.length === 0) {
    return (
      <div className="archive-list">
        <div className="topic-list-header">
          <h2>Archive</h2>
        </div>
        <div className="archive-empty">No archived topics</div>
      </div>
    );
  }

  return (
    <div className="archive-list">
      <div className="topic-list-header">
        <h2>Archive</h2>
        <span className="archive-count">{archivedTopics.length}</span>
      </div>
      <ul className="archive-items">
        {archivedTopics.map((topic) => {
          const origDivider = getDividerName(topic.archived_divider_id);
          const origSubject = getSubjectName(topic.archived_subject_id);
          const origin = origDivider || origSubject
            ? [origDivider, origSubject].filter(Boolean).join(' / ')
            : null;
          const archivedDate = topic.archived_at
            ? new Date(topic.archived_at).toLocaleDateString()
            : null;

          return (
            <li key={topic.id} className="archive-item">
              <div className="archive-item-info">
                <span className="topic-name">#{topic.id} {topic.name}</span>
                <span className="archive-item-meta">
                  {archivedDate && <span>Archived {archivedDate}</span>}
                  {origin && <span>from {origin}</span>}
                </span>
              </div>
              {canEdit && (
                <button
                  className="archive-restore-btn"
                  onClick={() => onRestore(topic.id)}
                  title="Restore topic"
                >
                  Restore
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
