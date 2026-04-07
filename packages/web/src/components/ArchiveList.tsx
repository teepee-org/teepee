import type { Topic } from '../types';

interface Props {
  archivedTopics: Topic[];
  onRestore: (topicId: number) => void;
  userRole: string;
}

export function ArchiveList({ archivedTopics, onRestore, userRole }: Props) {
  const canEdit = userRole !== 'observer';

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
          const archivedDate = topic.archived_at
            ? new Date(topic.archived_at).toLocaleDateString()
            : null;

          return (
            <li key={topic.id} className="archive-item">
              <div className="archive-item-info">
                <span className="topic-name">{topic.name} <span className="topic-id">#{topic.id}</span></span>
                {archivedDate && (
                  <span className="archive-item-meta">
                    <span>Archived {archivedDate}</span>
                  </span>
                )}
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
