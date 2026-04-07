import { useState, useCallback, useEffect } from 'react';
import { TopicTree } from './components/TopicTree';
import { ActivityBar } from './components/ActivityBar';
import type { ActivityView } from './components/ActivityBar';
import { ArchiveList } from './components/ArchiveList';
import { ChatView } from './components/ChatView';
import { InvitePage } from './components/InvitePage';
import { AdminPage } from './components/AdminPage';
import { useResizable } from './hooks/useResizable';
import { useWebSocket } from './useWebSocket';
import {
  fetchTopics, fetchAgents, fetchProject, createTopic, fetchMessages, postMessage,
  fetchArchivedTopics, apiArchiveTopic, apiRestoreTopic,
} from './api';
import type { ProjectInfo } from './api';
import type { Topic, Agent, Message, ServerEvent } from './types';
import { buildHelpMarkdown, COMMANDS } from './buildHelpMarkdown';

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

interface DemoRunState {
  topicId: number;
  nextPromptIndex: number;
  baselineMessageCount: number;
  sawActivity: boolean;
}

const DEMO_PATH_MATCH = window.location.pathname.match(/^\/demo(?:\/([^/]+))?\/?$/);
const DEMO_SEARCH_PARAMS = new URLSearchParams(window.location.search);
const DEMO_MODE_FROM_URL = Boolean(DEMO_PATH_MATCH) || DEMO_SEARCH_PARAMS.get('demo') === '1';
const DEMO_TOPIC_NAME_FROM_URL =
  decodeURIComponent(DEMO_PATH_MATCH?.[1] || '') || DEMO_SEARCH_PARAMS.get('demo_topic') || '';
const DEMO_HOTKEY_FROM_URL = DEMO_SEARCH_PARAMS.get('demo_hotkey') || '';
const DEMO_SETTLE_DELAY_MS_FROM_URL = Number(DEMO_SEARCH_PARAMS.get('demo_delay_ms') || 0);
const DEMO_PROMPTS = [
  '@coder @reviewer @architect introduce yourselves in one short sentence. Say only your role and what you do best.',
  '@reviewer review this workspace and give me 2 concrete findings with file references.',
  '@architect propose 1 small but worthwhile feature for this workspace, then turn it into a concrete task for "@coder".',
];

export function App() {
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [jobsByTopic, setJobsByTopic] = useState<Record<number, ActiveJob[]>>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [demoRun, setDemoRun] = useState<DemoRunState | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);
  const [archivedTopics, setArchivedTopics] = useState<Topic[]>([]);
  const [activeView, setActiveView] = useState<ActivityView>(() => {
    return (localStorage.getItem('teepee-active-view') as ActivityView) || 'topics';
  });

  const { width: sidebarWidth, collapsed: sidebarCollapsed, resizing, handleProps, toggleCollapsed } = useResizable({
    initialWidth: 260,
    minWidth: 180,
    maxWidthPercent: 50,
    storageKey: 'teepee-sidebar-width',
    collapsedKey: 'teepee-sidebar-collapsed',
  });

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
    fetchArchivedTopics().then(setArchivedTopics);
    fetchProject().then((p) => {
      setProject(p);
      document.title = `${p.name} — Teepee`;
    });
  }, [authUser]);

  // Persist active view
  useEffect(() => {
    localStorage.setItem('teepee-active-view', activeView);
  }, [activeView]);

  const demoEnabled = DEMO_MODE_FROM_URL || Boolean(project?.demo?.enabled);
  const demoTopicName =
    DEMO_TOPIC_NAME_FROM_URL ||
    project?.demo?.topic_name ||
    'hn-live-demo';
  const demoHotkey =
    DEMO_HOTKEY_FROM_URL ||
    project?.demo?.hotkey ||
    'F1';
  const demoDelayMs =
    (Number.isFinite(DEMO_SETTLE_DELAY_MS_FROM_URL) && DEMO_SETTLE_DELAY_MS_FROM_URL > 0
      ? DEMO_SETTLE_DELAY_MS_FROM_URL
      : 0) ||
    project?.demo?.delay_ms ||
    1200;

  // Derive active jobs for the current topic from the per-topic map
  const activeJobs = activeTopicId ? (jobsByTopic[activeTopicId] || []) : [];

  // Helper to update jobs for a specific topic
  const updateTopicJobs = useCallback(
    (topicId: number, updater: (prev: ActiveJob[]) => ActiveJob[]) => {
      setJobsByTopic((prev) => ({
        ...prev,
        [topicId]: updater(prev[topicId] || []),
      }));
    },
    []
  );

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
          updateTopicJobs(event.topicId, (prev) => [
            ...prev,
            {
              jobId: event.jobId,
              agentName: event.agentName,
              status: 'running',
              streamContent: '',
            },
          ]);
          break;

        case 'message.stream':
          updateTopicJobs(event.topicId, (prev) =>
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
          break;

        case 'agent.job.completed':
          // Mark job as done
          updateTopicJobs(event.topicId, (prev) =>
            prev.map((j) =>
              j.jobId === event.jobId ? { ...j, status: 'done' } : j
            )
          );
          if (event.message) {
            if (event.topicId === activeTopicId) {
              setMessages((prev) => {
                if (prev.some((m) => m.id === event.message.id)) return prev;
                return [...prev, event.message];
              });
            }
          }
          // Clean up done jobs after animation
          setTimeout(() => {
            updateTopicJobs(event.topicId, (prev) =>
              prev.filter((j) => j.jobId !== event.jobId)
            );
          }, 500);
          break;

        case 'agent.job.failed':
          // Remove slot
          updateTopicJobs(event.topicId, (prev) =>
            prev.filter((j) => j.jobId !== event.jobId)
          );
          if (event.topicId === activeTopicId) {
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

        case 'topics.changed':
          fetchTopics().then(setTopics);
          break;

      }
    },
    [activeTopicId, updateTopicJobs]
  );

  const { send, connected } = useWebSocket(onEvent);

  // Unsubscribe from topics that have no active jobs and aren't the current topic
  useEffect(() => {
    for (const key of Object.keys(jobsByTopic)) {
      const topicId = Number(key);
      if (topicId !== activeTopicId && jobsByTopic[topicId].length === 0) {
        send({ type: 'topic.leave', topicId });
        setJobsByTopic((prev) => {
          const next = { ...prev };
          delete next[topicId];
          return next;
        });
      }
    }
  }, [jobsByTopic, activeTopicId, send]);

  // Join topic via WebSocket
  // We intentionally do NOT send topic.leave so the server keeps delivering
  // streaming events for topics with in-flight agent jobs. The per-topic
  // jobsByTopic map preserves job state across switches.
  const handleSelectTopic = useCallback(
    (topicId: number) => {
      setActiveTopicId(topicId);
      setMessages([]);
      setSidebarOpen(false);
      send({ type: 'topic.join', topicId });
    },
    [send]
  );

  const handleCreateTopic = useCallback(async () => {
    const name = prompt('Topic name:');
    if (!name) return;
    const topic = await createTopic(name);
    setTopics((prev) => [...prev, { ...topic, language: null, archived: 0 }]);
    handleSelectTopic(topic.id);
  }, [handleSelectTopic]);

  const handleArchiveTopic = useCallback(async (topicId: number) => {
    await apiArchiveTopic(topicId);
    setTopics((prev) => prev.filter((t) => t.id !== topicId));
    fetchArchivedTopics().then(setArchivedTopics);
    if (activeTopicId === topicId) {
      setActiveTopicId(null);
      setMessages([]);
    }
  }, [activeTopicId]);

  const handleRestoreTopic = useCallback(async (topicId: number) => {
    await apiRestoreTopic(topicId);
    fetchTopics().then(setTopics);
    fetchArchivedTopics().then(setArchivedTopics);
  }, []);

  const handleChangeView = useCallback((view: ActivityView) => {
    setActiveView(view);
  }, []);

  const sleep = useCallback((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)), []);

  const startDemoAutoplay = useCallback(async () => {
    if (!demoEnabled || demoBusy || !authUser) return;

    setDemoBusy(true);
    try {
      const topicList = await fetchTopics();
      const existing = topicList.find((topic) => topic.name === demoTopicName);
      let topicId: number;

      if (existing) {
        topicId = existing.id;
      } else {
        const created = await createTopic(demoTopicName);
        topicId = created.id;
        setTopics((prev) => {
          if (prev.some((topic) => topic.id === created.id)) return prev;
          return [...prev, { ...created, language: null, archived: 0 }];
        });
      }

      handleSelectTopic(topicId);
      await sleep(250);
      const history = await fetchMessages(topicId, 200);
      const firstPrompt = DEMO_PROMPTS[0];
      await postMessage(topicId, firstPrompt);
      setDemoRun({
        topicId,
        nextPromptIndex: 1,
        baselineMessageCount: history.length + 1,
        sawActivity: false,
      });
    } finally {
      setDemoBusy(false);
    }
  }, [authUser, demoBusy, demoEnabled, demoTopicName, handleSelectTopic, sleep]);

  useEffect(() => {
    if (!demoRun) return;
    if (activeTopicId !== demoRun.topicId) return;

    if (!demoRun.sawActivity) {
      if (activeJobs.length > 0 || messages.length > demoRun.baselineMessageCount) {
        setDemoRun((prev) => (prev ? { ...prev, sawActivity: true } : prev));
      }
      return;
    }

    if (activeJobs.length > 0) return;

    if (demoRun.nextPromptIndex >= DEMO_PROMPTS.length) {
      setDemoRun(null);
      return;
    }

    const timeout = window.setTimeout(() => {
      const prompt = DEMO_PROMPTS[demoRun.nextPromptIndex];
      postMessage(demoRun.topicId, prompt)
        .then(() => {
          setDemoRun((prev) =>
            prev
              ? {
                  ...prev,
                  nextPromptIndex: prev.nextPromptIndex + 1,
                  baselineMessageCount: messages.length + 1,
                  sawActivity: false,
                }
              : prev
          );
        })
        .catch((error) => {
          console.error('demo autoplay failed', error);
          setDemoRun(null);
        });
    }, demoDelayMs);

    return () => window.clearTimeout(timeout);
  }, [activeJobs.length, activeTopicId, demoDelayMs, demoRun, messages.length]);

  useEffect(() => {
    if (!demoEnabled || !authUser) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== demoHotkey) return;
      event.preventDefault();
      startDemoAutoplay();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [authUser, demoEnabled, demoHotkey, startDemoAutoplay]);

  // Ctrl+Shift+E: focus topics view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        setActiveView('topics');
        if (sidebarCollapsed) toggleCollapsed();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sidebarCollapsed, toggleCollapsed]);

  const handleSend = useCallback(
    (text: string) => {
      // Helper: echo the typed command as a user message
      const echoCommand = (cmdText: string) => {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() - 1,
            topic_id: activeTopicId ?? 0,
            author_type: 'human' as const,
            author_name: authUser?.handle ?? 'you',
            body: cmdText,
            created_at: new Date().toISOString(),
          },
        ]);
      };

      // Helper: append a system message
      const systemReply = (body: string) => {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now(),
            topic_id: activeTopicId ?? 0,
            author_type: 'system' as const,
            author_name: 'teepee',
            body,
            created_at: new Date().toISOString(),
          },
        ]);
      };

      // Handle / commands
      if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const cmd = parts[0]?.toLowerCase();

        switch (cmd) {
          case 'help':
            echoCommand(text);
            systemReply(buildHelpMarkdown());
            return;

          case 'topics':
            echoCommand(text);
            fetchTopics().then((t) => {
              setTopics(t);
              systemReply(
                t.length === 0
                  ? 'No topics.'
                  : t.map((tp) => `**#${tp.id}** ${tp.name}`).join('\n')
              );
            });
            return;

          case 'join': {
            echoCommand(text);
            const id = parseInt(parts[1]);
            if (!isNaN(id)) handleSelectTopic(id);
            return;
          }

          case 'new': {
            echoCommand(text);
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
            echoCommand(text);
            systemReply(agents.map((a) => `**@${a.name}** (${a.provider})`).join('\n'));
            return;

          case 'topic': {
            echoCommand(text);
            const sub = parts[1]?.toLowerCase();
            if (!activeTopicId) return;
            if (sub === 'language' && parts[2]) {
              send({ type: 'command', command: 'topic.language', topicId: activeTopicId, language: parts[2] });
            } else if (sub === 'rename' && parts.slice(2).join(' ')) {
              send({ type: 'command', command: 'topic.rename', topicId: activeTopicId, name: parts.slice(2).join(' ') });
            } else if (sub === 'archive') {
              send({ type: 'command', command: 'topic.archive', topicId: activeTopicId });
            } else if (sub === 'move') {
              const action = parts[2]?.toLowerCase();
              if (action === 'root') {
                send({ type: 'command', command: 'topic.move.root', topicId: activeTopicId });
              } else if (action === 'into' && parts[3]) {
                send({ type: 'command', command: 'topic.move.into', topicId: activeTopicId, targetId: parseInt(parts[3]) });
              } else if (action === 'before' && parts[3]) {
                send({ type: 'command', command: 'topic.move.before', topicId: activeTopicId, targetId: parseInt(parts[3]) });
              } else if (action === 'after' && parts[3]) {
                send({ type: 'command', command: 'topic.move.after', topicId: activeTopicId, targetId: parseInt(parts[3]) });
              }
            }
            return;
          }

          case 'alias': {
            echoCommand(text);
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
    [activeTopicId, send, agents, handleSelectTopic, authUser]
  );

  const activeTopic = topics.find((t) => t.id === activeTopicId);

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

  const activeTopics = topics.filter((t) => !t.archived);

  // Render side panel content based on active view
  const renderSidePanel = () => {
    if (activeView === 'archive') {
      return (
        <ArchiveList
          archivedTopics={archivedTopics}
          onRestore={handleRestoreTopic}
          userRole={authUser.role}
        />
      );
    }
    // Default: topics view
    return (
      <TopicTree
        topics={activeTopics}
        activeTopicId={activeTopicId}
        onSelectTopic={handleSelectTopic}
        onCreateTopic={handleCreateTopic}
        onArchiveTopic={handleArchiveTopic}
        userRole={authUser.role}
      />
    );
  };

  return (
    <div className="app">
      {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
      <ActivityBar
        activeView={activeView}
        onChangeView={handleChangeView}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleCollapsed}
        archiveCount={archivedTopics.length}
        isOwner={authUser.role === 'owner'}
      />
      <aside
        className={`sidebar ${sidebarOpen ? 'open' : ''} ${sidebarCollapsed || activeView === 'settings' ? 'collapsed' : ''} ${resizing ? 'resizing' : ''}`}
        style={{ width: sidebarCollapsed || activeView === 'settings' ? 0 : sidebarWidth }}
      >
        <div className="sidebar-header">
          <span className={`connection-dot ${connected ? 'connected' : ''}`} />
          <div className="project-info">
            <h1>{project?.name || 'Teepee'}</h1>
            {project && (
              <span className="project-meta">
                {project.path.replace(/^\/home\/[^/]+/, '~')}
                {project.gitBranch && <> &middot; {project.gitBranch}</>}
              </span>
            )}
          </div>
          {/* Mobile-only view switcher icons */}
          <div className="drawer-header-actions">
            <button
              className={`drawer-view-btn ${activeView === 'archive' ? 'active' : ''}`}
              onClick={() => setActiveView(activeView === 'archive' ? 'topics' : 'archive')}
              aria-label="Archive"
              title="Archive"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="16" height="4" rx="1" />
                <path d="M3 7v8a2 2 0 002 2h10a2 2 0 002-2V7" />
                <path d="M8 11h4" />
              </svg>
              {archivedTopics.length > 0 && <span className="drawer-badge">{archivedTopics.length}</span>}
            </button>
            {authUser.role === 'owner' && (
              <button
                className={`drawer-view-btn ${activeView === 'settings' ? 'active' : ''}`}
                onClick={() => { setSidebarOpen(false); setActiveView('settings'); }}
                aria-label="Settings"
                title="Settings"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="10" cy="10" r="3" />
                  <path d="M10 1.5v2M10 16.5v2M3.05 5l1.73 1M15.22 14l1.73 1M1.5 10h2M16.5 10h2M3.05 15l1.73-1M15.22 6l1.73-1" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {renderSidePanel()}
        <div className="agents-section">
          <h3>Agents</h3>
          <ul className="agents-list">
            {agents.map((a) => (
              <li key={a.name}>
                {a.name} <span className="provider-badge">{a.provider}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="user-section">
          <span className="user-handle">{authUser.handle}</span>
          <span className="user-role">{authUser.role}</span>
          {demoEnabled && authUser.role === 'owner' && (
            <button
              className="admin-btn"
              onClick={() => {
                void startDemoAutoplay();
              }}
              title={`Run demo prompts (${demoHotkey})`}
              disabled={demoBusy || !!demoRun}
            >
              Demo {demoHotkey}
            </button>
          )}
          {authUser.role === 'owner' && (
            <button
              className="admin-btn"
              onClick={() => {
                setSidebarOpen(false);
                setActiveView('settings');
              }}
              title="Admin"
            >
              Admin
            </button>
          )}
        </div>
        {/* Resize handle (desktop only) */}
        <div className={`sidebar-resize-handle ${resizing ? 'dragging' : ''}`} {...handleProps} />
      </aside>
      <main className="main">
        {activeView === 'settings' && authUser.role === 'owner' ? (
          <AdminPage agents={agents} />
        ) : activeTopic ? (
          <ChatView
            topicId={activeTopic.id}
            topicName={activeTopic.name}
            messages={messages}
            onMenuToggle={() => setSidebarOpen(true)}
            agents={agents}
            commands={COMMANDS}
            activeJobs={activeJobs}
            onSend={handleSend}
          />
        ) : (
          <div className="empty-state">
            <button className="mobile-menu-btn empty-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="24" height="24" viewBox="0 0 20 20" fill="currentColor">
                <rect y="3" width="20" height="2" rx="1"/>
                <rect y="9" width="20" height="2" rx="1"/>
                <rect y="15" width="20" height="2" rx="1"/>
              </svg>
            </button>
            <h2>Select a topic to start</h2>
            <p>Or create a new one with +</p>
            <p>Type <code>/help</code> in any topic to see available commands.</p>
            {demoEnabled && authUser.role === 'owner' && (
              <p>
                Demo mode is on. Press {demoHotkey} or click the Demo button to send the prompt sequence to
                {' '}{demoTopicName}.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
