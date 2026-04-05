import type { Topic } from '../types';

interface Props {
  topics: Topic[];
  activeTopicId: number | null;
  onSelectTopic: (id: number) => void;
  onCreateTopic: () => void;
}

export function TopicList({ topics, activeTopicId, onSelectTopic, onCreateTopic }: Props) {
  return (
    <div className="topic-list">
      <div className="topic-list-header">
        <h2>Topics</h2>
        <button onClick={onCreateTopic} title="New topic">+</button>
      </div>
      <ul>
        {topics.map((topic) => (
          <li
            key={topic.id}
            className={topic.id === activeTopicId ? 'active' : ''}
            onClick={() => onSelectTopic(topic.id)}
          >
            <span className="topic-name">#{topic.id} {topic.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
