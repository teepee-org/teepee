import { useState, useCallback, useEffect } from 'react';
import { TopicList } from './components/TopicList';
import { ChatView } from './components/ChatView';
import { InvitePage } from './components/InvitePage';
import { AdminPage } from './components/AdminPage';
import { useWebSocket } from './useWebSocket';
import { fetchTopics, fetchAgents, fetchProject, createTopic } from './api';
import type { ProjectInfo } from './api';
import type { Topic, Agent, Message, ServerEvent } from './types';

interface ActiveJob {
  jobId: number;
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
}

interface AuthUser {
  email: string;
  handle: string;
  role: string;
}

export function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeJobs, setActiveJobs] = useState<ActiveJob[]>([]);
  const [showAdmin, setShowAdmin] = useState(false);

  // Check if on invite page
  const inviteToken = window.location.pathname.match(/^\/invite\/([a-f0-9]+)$/)?.[1];

  // Check auth on mount
  useEffect(() => {
    if (inviteToken) {
      setAuthLoading(false);
      return;
    }
    fetch('/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data.email) {
          setAuthUser(data);
        }
        setAuthLoading(false);
      })
      .catch(() => setAuthLoading(false));
  }, [inviteToken]);

  // Load data after auth
  useEffect(() => {
    if (!authUser) return;
    fetchTopics().then(setTopics);
    fetchAgents().then(setAgents);
    fetchProject().then((p) => {
      setProject(p);
      document.title = `${p.name} — Teepee`;
    });
  }, [authUser]);

  // WebSocket event handler
  const onEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case 'topic.history':
          if (event.topicId === activeTopicId) {
            setMessages(event.messages);
          }
          break;

        case 'message.created':
          if (event.topicId === activeTopicId) {
            setMessages((prev) => {
              // Avoid duplicates
              if (prev.some((m) => m.id === event.message.id)) return prev;
              return [...prev, event.message];
            });
          }
          break;

        case 'agent.job.started':
          if (event.topicId === activeTopicId) {
            setActiveJobs((prev) => [
              ...prev,
              {
                jobId: event.jobId,
                agentName: event.agentName,
                status: 'running',
                streamContent: '',
              },
            ]);
          }
          break;

        case 'message.stream':
          if (event.topicId === activeTopicId) {
            setActiveJobs((prev) =>
              prev.map((j) =>
                j.jobId === event.jobId
                  ? {
                      ...j,
                      status: 'streaming',
                      streamContent: j.streamContent + event.chunk,
                    }
                  : j
              )
            );
          }
          break;

        case 'agent.job.completed':
          if (event.topicId === activeTopicId) {
            // Remove from active jobs, add message
            setActiveJobs((prev) =>
              prev.map((j) =>
                j.jobId === event.jobId ? { ...j, status: 'done' } : j
              )
            );
            if (event.message) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === event.message.id)) return prev;
                return [...prev, event.message];
              });
            }
            // Clean up done jobs after animation
            setTimeout(() => {
              setActiveJobs((prev) =>
                prev.filter((j) => j.jobId !== event.jobId)
              );
            }, 500);
          }
          break;

        case 'agent.job.failed':
          if (event.topicId === activeTopicId) {
            // Remove slot and add error as message in timeline
            setActiveJobs((prev) => prev.filter((j) => j.jobId !== event.jobId));
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now(),
                topic_id: event.topicId,
                author_type: 'system' as const,
                author_name: event.agentName,
                body: `**@${event.agentName}** failed: ${event.error}`,
                created_at: new Date().toISOString(),
              },
            ]);
          }
          break;

        case 'system':
          if (event.topicId === activeTopicId) {
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now(),
                topic_id: event.topicId,
                author_type: 'system',
                author_name: 'teepee',
                body: event.text,
                created_at: new Date().toISOString(),
              },
            ]);
          }
          break;
      }
    },
    [activeTopicId]
  );

  const { send, connected } = useWebSocket(onEvent);

  // Join topic via WebSocket
  const handleSelectTopic = useCallback(
    (topicId: number) => {
      // Leave previous topic
      if (activeTopicId) {
        send({ type: 'topic.leave', topicId: activeTopicId });
      }
      setActiveTopicId(topicId);
      setMessages([]);
      setActiveJobs([]);
      send({ type: 'topic.join', topicId });
    },
    [activeTopicId, send]
  );

  const handleCreateTopic = useCallback(async () => {
    const name = prompt('Topic name:');
    if (!name) return;
    const topic = await createTopic(name);
    setTopics((prev) => [...prev, { ...topic, language: null, archived: 0 }]);
    handleSelectTopic(topic.id);
  }, [handleSelectTopic]);

  const handleSend = useCallback(
    (text: string) => {
      // Handle / commands
      if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const cmd = parts[0]?.toLowerCase();

        switch (cmd) {
          case 'help':
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now(),
                topic_id: activeTopicId ?? 0,
                author_type: 'system' as const,
                author_name: 'teepee',
                body: [
                  '**Commands:**',
                  '`/topics` — list topics',
                  '`/join <id>` — switch to topic',
                  '`/new <name>` — create topic',
                  '`/topic rename <name>` — rename current topic',
                  '`/topic language <lang>` — set topic language',
                  '`/topic archive` — archive current topic',
                  '`/alias @agent @short` — create alias',
                  '`/agents` — list available agents',
                  '`/help` — this message',
                ].join('\n'),
                created_at: new Date().toISOString(),
              },
            ]);
            return;

          case 'topics':
            fetchTopics().then((t) => {
              setTopics(t);
              setMessages((prev) => [
                ...prev,
                {
                  id: Date.now(),
                  topic_id: activeTopicId ?? 0,
                  author_type: 'system' as const,
                  author_name: 'teepee',
                  body: t.length === 0
                    ? 'No topics.'
                    : t.map((tp) => `**#${tp.id}** ${tp.name}`).join('\n'),
                  created_at: new Date().toISOString(),
                },
              ]);
            });
            return;

          case 'join': {
            const id = parseInt(parts[1]);
            if (!isNaN(id)) handleSelectTopic(id);
            return;
          }

          case 'new': {
            const name = parts.slice(1).join(' ');
            if (name) {
              createTopic(name).then((topic) => {
                setTopics((prev) => [...prev, { ...topic, language: null, archived: 0 }]);
                handleSelectTopic(topic.id);
              });
            }
            return;
          }

          case 'agents':
            setMessages((prev) => [
              ...prev,
              {
                id: Date.now(),
                topic_id: activeTopicId ?? 0,
                author_type: 'system' as const,
                author_name: 'teepee',
                body: agents.map((a) => `**@${a.name}** (${a.provider})`).join('\n'),
                created_at: new Date().toISOString(),
              },
            ]);
            return;

          case 'topic': {
            const sub = parts[1]?.toLowerCase();
            if (!activeTopicId) return;
            if (sub === 'language' && parts[2]) {
              send({ type: 'command', command: 'topic.language', topicId: activeTopicId, language: parts[2] });
            } else if (sub === 'rename' && parts.slice(2).join(' ')) {
              send({ type: 'command', command: 'topic.rename', topicId: activeTopicId, name: parts.slice(2).join(' ') });
            } else if (sub === 'archive') {
              send({ type: 'command', command: 'topic.archive', topicId: activeTopicId });
            }
            return;
          }

          case 'alias': {
            if (!activeTopicId || parts.length < 3) return;
            const agent = parts[1].replace('@', '');
            const alias = parts[2].replace('@', '');
            send({ type: 'command', command: 'topic.alias', topicId: activeTopicId, agent, alias });
            return;
          }
        }
        return;
      }

      if (!activeTopicId) return;
      send({ type: 'message.send', topicId: activeTopicId, body: text });
    },
    [activeTopicId, send, agents, handleSelectTopic]
  );

  const activeTopic = topics.find((t) => t.id === activeTopicId);

  // Admin page (full screen)
  if (showAdmin && authUser?.role === 'owner') {
    return <AdminPage agents={agents} onBack={() => setShowAdmin(false)} />;
  }

  // Loading
  if (authLoading) {
    return (
      <div className="auth-page">
        <div className="auth-card"><h1>Teepee</h1><p>Loading...</p></div>
      </div>
    );
  }

  // Invite page
  if (inviteToken) {
    return (
      <InvitePage
        token={inviteToken}
        onAccepted={() => {
          window.location.href = '/';
        }}
      />
    );
  }

  // Not authenticated
  if (!authUser) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Teepee</h1>
          <p>You need an invite link to access this Teepee.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="project-info">
            <h1>{project?.name || 'Teepee'}</h1>
            {project && (
              <span className="project-meta">
                {project.path.replace(/^\/home\/[^/]+/, '~')}
                {project.gitBranch && <> &middot; {project.gitBranch}</>}
              </span>
            )}
          </div>
          <span className={`connection-dot ${connected ? 'connected' : ''}`} />
        </div>
        <TopicList
          topics={topics}
          activeTopicId={activeTopicId}
          onSelectTopic={handleSelectTopic}
          onCreateTopic={handleCreateTopic}
        />
        <div className="agents-section">
          <h3>Agents</h3>
          <ul className="agents-list">
            {agents.map((a) => (
              <li key={a.name}>
                🤖 {a.name} <span className="provider-badge">{a.provider}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="user-section">
          <span className="user-handle">{authUser.handle}</span>
          <span className="user-role">{authUser.role}</span>
          {authUser.role === 'owner' && (
            <button className="admin-btn" onClick={() => setShowAdmin(true)} title="Admin">
              Admin
            </button>
          )}
        </div>
      </aside>
      <main className="main">
        {activeTopic ? (
          <ChatView
            topicId={activeTopic.id}
            topicName={activeTopic.name}
            messages={messages}
            agents={agents}
            activeJobs={activeJobs}
            onSend={handleSend}
          />
        ) : (
          <div className="empty-state">
            <h2>Select a topic to start</h2>
            <p>Or create a new one with +</p>
          </div>
        )}
      </main>
    </div>
  );
}
