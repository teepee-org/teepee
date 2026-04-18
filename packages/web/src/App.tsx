import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { TopicTree } from './components/TopicTree';
import { ActivityBar } from './components/ActivityBar';
import type { ActivityView } from './components/ActivityBar';
import { ArchiveList } from './components/ArchiveList';
import { ChatView } from './components/ChatView';
import { InvitePage } from './components/InvitePage';
import { AdminPage } from './components/AdminPage';
import { SearchPanel } from './components/SearchPanel';
import { FilesystemExplorer } from './components/FilesystemExplorer';
import { FilePreview } from './components/FilePreview';
import type { FileSelection } from './components/FileTree';
import { useResizable } from './hooks/useResizable';
import { useWebSocket } from './useWebSocket';
import {
  fetchTopics, fetchAgents, fetchProject, createTopic, fetchMessages, fetchMessagesAround, postMessage,
  fetchArchivedTopics, apiArchiveTopic, apiRestoreTopic, apiRenameTopic, fetchPresence,
  fetchTopicInputRequests, fetchActiveTopicJobs, answerInputRequest, cancelInputRequest,
} from './api';
import type { ProjectInfo, PresenceEntry, PendingInputRequest, TopicJobSnapshot } from './api';
import type { Topic, Agent, Message, ServerEvent } from './types';
import type { Capability, MessageSearchResult } from 'teepee-core';
import { buildHelpMarkdown, COMMANDS } from './buildHelpMarkdown';

interface ActiveJob {
  jobId: number;
  agentName: string;
  status: 'queued' | 'running' | 'streaming' | 'done' | 'failed';
  streamContent: string;
  error?: string;
  phase?: string;
  round?: number;
}

interface AuthUser {
  id: string;
  email: string;
  handle: string | null;
  role: string;
  isOwner: boolean;
  capabilities: Capability[];
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

function toSentMessage(message: Message): Message {
  return {
    ...message,
    delivery_status: 'sent',
    delivery_error: undefined,
  };
}

function mergeSnapshotWithLocal(serverMessages: Message[], currentMessages: Message[]): Message[] {
  const normalized = serverMessages.map(toSentMessage);
  const seenClientIds = new Set(
    normalized
      .map((message) => message.client_message_id)
      .filter((value): value is string => Boolean(value))
  );
  const pendingLocal = currentMessages.filter((message) => (
    message.delivery_status &&
    message.delivery_status !== 'sent' &&
    (!message.client_message_id || !seenClientIds.has(message.client_message_id))
  ));
  return [...normalized, ...pendingLocal];
}

function upsertMessage(prev: Message[], nextMessage: Message): Message[] {
  const normalized = toSentMessage(nextMessage);
  const nextClientId = normalized.client_message_id ?? null;
  const index = prev.findIndex((message) => (
    message.id === normalized.id ||
    (nextClientId && message.client_message_id === nextClientId)
  ));
  if (index === -1) {
    return [...prev, normalized];
  }
  const next = prev.slice();
  next[index] = normalized;
  return next;
}

function updateLocalMessage(
  prev: Message[],
  clientMessageId: string,
  updater: (message: Message) => Message
): Message[] {
  let changed = false;
  const next = prev.map((message) => {
    if (message.client_message_id !== clientMessageId) {
      return message;
    }
    changed = true;
    return updater(message);
  });
  return changed ? next : prev;
}

function createClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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
  const [focusedTopicId, setFocusedTopicId] = useState<number | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [inputRequestsByTopic, setInputRequestsByTopic] = useState<Record<number, PendingInputRequest[]>>({});
  const [activeView, setActiveView] = useState<ActivityView>(() => {
    return (localStorage.getItem('teepee-active-view') as ActivityView) || 'topics';
  });
  const [fileSelection, setFileSelection] = useState<FileSelection | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string; variant: 'success' | 'error' } | null>(null);
  const activeTopicIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const notify = useCallback((message: string, variant: 'success' | 'error') => {
    setToast({ id: Date.now(), message, variant });
  }, []);

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
    fetchPresence().then(setPresence);
    fetchProject().then((p) => {
      setProject(p);
      document.title = `${p.name} — Teepee`;
    });
  }, [authUser]);

  // Persist active view
  useEffect(() => {
    localStorage.setItem('teepee-active-view', activeView);
  }, [activeView]);

  useEffect(() => {
    activeTopicIdRef.current = activeTopicId;
  }, [activeTopicId]);

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
  const activeInputRequests = activeTopicId ? (inputRequestsByTopic[activeTopicId] || []) : [];
  const authCapabilities = useMemo(() => new Set<Capability>(authUser?.capabilities ?? []), [authUser]);
  const can = useCallback((capability: Capability) => authCapabilities.has(capability), [authCapabilities]);

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

  const updateTopicInputRequests = useCallback(
    (topicId: number, updater: (prev: PendingInputRequest[]) => PendingInputRequest[]) => {
      setInputRequestsByTopic((prev) => ({
        ...prev,
        [topicId]: updater(prev[topicId] || []),
      }));
    },
    []
  );

  const syncTopicJobsFromSnapshot = useCallback((topicId: number, snapshot: TopicJobSnapshot[]) => {
    setJobsByTopic((prev) => {
      const existing = prev[topicId] || [];
      const existingById = new Map(existing.map((job) => [job.jobId, job]));
      const next = snapshot.map((job) => {
        const current = existingById.get(job.id);
        return {
          jobId: job.id,
          agentName: job.agent_name,
          status: job.status,
          streamContent: current?.streamContent || '',
          error: job.error ?? current?.error,
        } satisfies ActiveJob;
      });
      return { ...prev, [topicId]: next };
    });
  }, []);

  const refreshTopicRuntime = useCallback(async (topicId: number) => {
    const [requests, jobs] = await Promise.all([
      fetchTopicInputRequests(topicId),
      fetchActiveTopicJobs(topicId),
    ]);
    setInputRequestsByTopic((prev) => ({ ...prev, [topicId]: requests }));
    syncTopicJobsFromSnapshot(topicId, jobs);
  }, [syncTopicJobsFromSnapshot]);

  const refreshTopicSnapshot = useCallback(async (topicId: number, aroundMessageId?: number) => {
    const messagePromise = aroundMessageId
      ? fetchMessagesAround(topicId, aroundMessageId, 25)
      : fetchMessages(topicId, 200);
    const [loadedMessages] = await Promise.all([
      messagePromise,
      refreshTopicRuntime(topicId),
    ]);
    if (activeTopicIdRef.current === topicId) {
      setMessages((prev) => mergeSnapshotWithLocal(loadedMessages, prev));
    }
  }, [refreshTopicRuntime]);

  // WebSocket event handler
  const onEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        case 'topic.history':
          if (event.topicId === activeTopicId) {
            setMessages((prev) => mergeSnapshotWithLocal(event.messages, prev));
          }
          break;

        case 'message.created':
          if (event.topicId === activeTopicId) {
            setMessages((prev) => upsertMessage(prev, event.message));
          }
          break;

        case 'agent.job.started':
          updateTopicJobs(event.topicId, (prev) =>
            prev.some((job) => job.jobId === event.jobId)
              ? prev.map((job) =>
                  job.jobId === event.jobId
                    ? { ...job, agentName: event.agentName, status: 'running', error: undefined }
                    : job
                )
              : [
                  ...prev,
                  {
                    jobId: event.jobId,
                    agentName: event.agentName,
                    status: 'running',
                    streamContent: '',
                  },
                ]
          );
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

        case 'agent.job.retrying':
          updateTopicJobs(event.topicId, (prev) =>
            prev.map((j) =>
              j.jobId === event.jobId
                ? {
                    ...j,
                    status: 'running',
                    streamContent: '',
                    error: event.error,
                  }
                : j
            )
          );
          break;

        case 'agent.job.round_started':
          updateTopicJobs(event.topicId, (prev) => {
            const exists = prev.some((j) => j.jobId === event.jobId);
            if (!exists) {
              return [
                ...prev,
                {
                  jobId: event.jobId,
                  agentName: event.agentName,
                  status: 'running',
                  streamContent: '',
                  phase: event.phase,
                  round: event.round,
                },
              ];
            }
            return prev.map((j) =>
              j.jobId === event.jobId
                ? {
                    ...j,
                    status: 'running',
                    streamContent: '',
                    error: undefined,
                    phase: event.phase,
                    round: event.round,
                  }
                : j
            );
          });
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
              setMessages((prev) => upsertMessage(prev, event.message));
            }
          }
          // Clean up done jobs after animation
          setTimeout(() => {
            updateTopicJobs(event.topicId, (prev) =>
              prev.filter((j) => j.jobId !== event.jobId)
            );
          }, 500);
          break;

        case 'agent.job.waiting_input':
          updateTopicJobs(event.topicId, (prev) =>
            prev.filter((j) => j.jobId !== event.jobId)
          );
          fetchTopicInputRequests(event.topicId)
            .then((requests) => {
              setInputRequestsByTopic((prev) => ({ ...prev, [event.topicId]: requests }));
            })
            .catch(() => {});
          if (event.topicId === activeTopicId) {
            fetchMessages(event.topicId, 200).then(setMessages).catch(() => {});
          }
          break;

        case 'job.input.answered':
          updateTopicInputRequests(event.topicId, (prev) =>
            prev.map((request) =>
              request.requestId === event.requestId
                ? { ...request, status: 'answered' }
                : request
            )
          );
          break;

        case 'job.input.cancelled':
          updateTopicInputRequests(event.topicId, (prev) =>
            prev.map((request) =>
              request.requestId === event.requestId
                ? { ...request, status: 'cancelled' }
                : request
            )
          );
          break;

        case 'job.input.expired':
          updateTopicInputRequests(event.topicId, (prev) =>
            prev.map((request) =>
              request.requestId === event.requestId
                ? { ...request, status: 'expired' }
                : request
            )
          );
          break;

        case 'agent.job.resumed':
          updateTopicInputRequests(event.topicId, (prev) =>
            prev.filter((request) => request.requestId !== event.requestId)
          );
          updateTopicJobs(event.topicId, (prev) =>
            prev.some((job) => job.jobId === event.jobId)
              ? prev.map((job) =>
                  job.jobId === event.jobId
                    ? { ...job, status: 'running', streamContent: '', error: undefined }
                    : job
                )
              : [...prev, { jobId: event.jobId, agentName: event.agentName, status: 'running', streamContent: '' }]
          );
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
          fetchArchivedTopics().then(setArchivedTopics);
          break;

        case 'presence.changed':
          setPresence((event as any).presence);
          break;

      }
    },
    [activeTopicId, updateTopicInputRequests, updateTopicJobs]
  );

  const { send, connected } = useWebSocket(onEvent);

  // Heartbeat for presence
  useEffect(() => {
    if (!connected) return;
    const interval = setInterval(() => {
      send({ type: 'presence.heartbeat' });
    }, 25_000);
    return () => clearInterval(interval);
  }, [connected, send]);

  // Re-send active topic on reconnect
  const prevConnected = useRef(false);
  useEffect(() => {
    if (connected && !prevConnected.current) {
      const topicIds = new Set<number>();
      if (activeTopicId) {
        topicIds.add(activeTopicId);
        void refreshTopicSnapshot(activeTopicId, highlightedMessageId ?? undefined).catch(() => {});
        send({ type: 'presence.active_topic', topicId: activeTopicId });
      }
      for (const [topicIdText, jobs] of Object.entries(jobsByTopic)) {
        if (jobs.length === 0) continue;
        const topicId = Number(topicIdText);
        topicIds.add(topicId);
        if (topicId !== activeTopicId) {
          void refreshTopicRuntime(topicId).catch(() => {});
        }
      }
      for (const topicId of topicIds) {
        send(topicId === activeTopicId && highlightedMessageId
          ? { type: 'topic.join', topicId, aroundMessageId: highlightedMessageId, radius: 25 }
          : { type: 'topic.join', topicId });
      }
    }
    prevConnected.current = connected;
  }, [connected, activeTopicId, highlightedMessageId, jobsByTopic, refreshTopicRuntime, refreshTopicSnapshot, send]);

  // Unsubscribe from topics that have no active jobs and aren't the current topic
  useEffect(() => {
    for (const key of Object.keys(jobsByTopic)) {
      const topicId = Number(key);
      const topicJobs = jobsByTopic[topicId] || [];
      if (topicId !== activeTopicId && topicJobs.length === 0) {
        send({ type: 'topic.leave', topicId });
        setJobsByTopic((prev) => {
          const next = { ...prev };
          delete next[topicId];
          return next;
        });
      }
    }
  }, [jobsByTopic, activeTopicId, send]);

  // Load the selected topic via HTTP snapshot, then keep it subscribed via WS.
  // We intentionally do NOT send topic.leave so the server keeps delivering
  // streaming events for topics with in-flight agent jobs.
  const handleSelectTopic = useCallback(
    (topicId: number, aroundMessageId?: number) => {
      setActiveTopicId(topicId);
      activeTopicIdRef.current = topicId;
      setMessages([]);
      setHighlightedMessageId(aroundMessageId ?? null);
      setSidebarOpen(false);
      send(aroundMessageId
        ? { type: 'topic.join', topicId, aroundMessageId, radius: 25 }
        : { type: 'topic.join', topicId });
      send({ type: 'presence.active_topic', topicId });
      void refreshTopicSnapshot(topicId, aroundMessageId).catch(() => {});
      // Auto-clear focus if joining outside focused subtree
      setFocusedTopicId((prev) => {
        if (!prev) return null;
        // Check if topicId is within the focused subtree
        const focusedIds = new Set<number>();
        focusedIds.add(prev);
        for (const t of topics) {
          if (!t.archived && focusedIds.has(t.parent_topic_id!)) {
            focusedIds.add(t.id);
          }
        }
        return focusedIds.has(topicId) ? prev : null;
      });
    },
    [refreshTopicSnapshot, send, topics]
  );

  const handleOpenSearchMessage = useCallback((result: MessageSearchResult) => {
    handleSelectTopic(result.topicId, result.messageId);
  }, [handleSelectTopic]);

  const handleCreateTopic = useCallback(async () => {
    const name = prompt('Topic name:');
    if (!name) return;
    const topic = await createTopic(name);
    fetchTopics().then(setTopics);
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

  const handleRenameTopic = useCallback(async (topicId: number, currentName: string) => {
    const newName = prompt('Rename topic:', currentName);
    if (!newName || newName.trim() === currentName) return;
    await apiRenameTopic(topicId, newName.trim());
    fetchTopics().then(setTopics);
  }, []);

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
    (text: string): boolean => {
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
            return true;

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
            return true;

          case 'join': {
            echoCommand(text);
            const id = parseInt(parts[1]);
            if (!isNaN(id)) { handleSelectTopic(id); return true; }
            return false;
          }

          case 'new': {
            echoCommand(text);
            if (!can('topics.create')) {
              systemReply('You are not allowed to create topics.');
              return true;
            }
            const name = parts.slice(1).join(' ');
            if (name) {
              createTopic(name).then((topic) => {
                fetchTopics().then(setTopics);
                handleSelectTopic(topic.id);
              });
              return true;
            }
            return false;
          }

          case 'agents':
            echoCommand(text);
            systemReply(agents.map((a) => `**@${a.name}** (${a.provider})`).join('\n'));
            return true;

          case 'topic': {
            const sub = parts[1]?.toLowerCase();
            if (!activeTopicId) return false;
            echoCommand(text);
            if (sub === 'new' && parts.slice(2).join(' ')) {
              if (!can('topics.create')) {
                systemReply('You are not allowed to create topics.');
                return true;
              }
              const childName = parts.slice(2).join(' ');
              createTopic(childName, activeTopicId).then((topic) => {
                fetchTopics().then(setTopics);
                handleSelectTopic(topic.id);
              });
              return true;
            } else if (sub === 'language' && parts[2]) {
              send({ type: 'command', command: 'topic.language', topicId: activeTopicId, language: parts[2] });
              return true;
            } else if (sub === 'rename' && parts.slice(2).join(' ')) {
              send({ type: 'command', command: 'topic.rename', topicId: activeTopicId, name: parts.slice(2).join(' ') });
              return true;
            } else if (sub === 'archive') {
              send({ type: 'command', command: 'topic.archive', topicId: activeTopicId });
              return true;
            } else if (sub === 'move') {
              const action = parts[2]?.toLowerCase();
              if (action === 'root') {
                send({ type: 'command', command: 'topic.move.root', topicId: activeTopicId });
                return true;
              } else if (action === 'into' && parts[3]) {
                send({ type: 'command', command: 'topic.move.into', topicId: activeTopicId, targetId: parseInt(parts[3]) });
                return true;
              } else if (action === 'before' && parts[3]) {
                send({ type: 'command', command: 'topic.move.before', topicId: activeTopicId, targetId: parseInt(parts[3]) });
                return true;
              } else if (action === 'after' && parts[3]) {
                send({ type: 'command', command: 'topic.move.after', topicId: activeTopicId, targetId: parseInt(parts[3]) });
                return true;
              }
            }
            return false;
          }

          case 'alias': {
            if (!activeTopicId || parts.length < 3) return false;
            echoCommand(text);
            const agent = parts[1].replace('@', '');
            const alias = parts[2].replace('@', '');
            send({ type: 'command', command: 'topic.alias', topicId: activeTopicId, agent, alias });
            return true;
          }

          case 'focus': {
            if (!activeTopicId) return false;
            echoCommand(text);
            const focusTopic = topics.find((t) => t.id === activeTopicId);
            setFocusedTopicId(activeTopicId);
            systemReply(`Focused on **${focusTopic?.name || '#' + activeTopicId}**. Use \`/unfocus\` or click "Show all" to restore the full tree.`);
            return true;
          }

          case 'unfocus': {
            echoCommand(text);
            setFocusedTopicId(null);
            systemReply('Focus cleared. Showing all topics.');
            return true;
          }

          case 'who': {
            echoCommand(text);
            if (presence.length === 0) {
              systemReply('No one else is online.');
            } else {
              const lines = presence.map((p) => {
                const topicInfo = p.activeTopicId
                  ? `#${p.activeTopicId} ${topics.find((t) => t.id === p.activeTopicId)?.name || ''}`
                  : 'no topic selected';
                const idle = p.state === 'idle' ? ' (idle)' : '';
                return `- **${p.displayName}** (${p.role}) — ${topicInfo}${idle}`;
              });
              systemReply(`Online now:\n${lines.join('\n')}`);
            }
            return true;
          }
        }
        return false; // Unknown slash command
      }

      if (!activeTopicId) return false;
      if (!can('messages.post')) {
        systemReply('You are not allowed to post messages.');
        return true;
      }
      const topicId = activeTopicId;
      const clientMessageId = createClientMessageId();
      const optimisticMessage: Message = {
        id: `pending:${clientMessageId}`,
        topic_id: topicId,
        author_type: 'user',
        author_name: authUser?.handle || authUser?.email || 'you',
        client_message_id: clientMessageId,
        body: text,
        created_at: new Date().toISOString(),
        delivery_status: 'pending',
      };
      if (activeTopicIdRef.current === topicId) {
        setMessages((prev) => [...prev, optimisticMessage]);
      }
      void postMessage(topicId, text, undefined, clientMessageId)
        .then(({ message }) => {
          if (message && activeTopicIdRef.current === topicId) {
            setMessages((prev) => upsertMessage(prev, message));
          }
          void refreshTopicRuntime(topicId).catch(() => {});
        })
        .catch((error: Error) => {
          if (activeTopicIdRef.current !== topicId) return;
          setMessages((prev) => updateLocalMessage(
            prev,
            clientMessageId,
            (message) => ({
              ...message,
              delivery_status: 'failed',
              delivery_error: error.message,
            })
          ));
        });
      return true;
    },
    [activeTopicId, send, agents, handleSelectTopic, authUser, topics, presence, refreshTopicRuntime, can]
  );

  const handleAnswerInput = useCallback(async (requestId: number, payload: { value: boolean | string | string[]; comment?: string }) => {
    await answerInputRequest(requestId, payload);
  }, []);

  const handleCancelInput = useCallback(async (requestId: number) => {
    await cancelInputRequest(requestId);
  }, []);

  const activeTopic = topics.find((t) => t.id === activeTopicId);
  const activeTopics = topics.filter((t) => !t.archived);

  // Focus mode: filter to focused subtree
  const displayTopics = useMemo(() => {
    if (!focusedTopicId) return activeTopics;
    const focusedIds = new Set<number>();
    if (!activeTopics.some((t) => t.id === focusedTopicId)) return activeTopics;
    focusedIds.add(focusedTopicId);
    for (const t of activeTopics) {
      if (focusedIds.has(t.parent_topic_id!)) {
        focusedIds.add(t.id);
      }
    }
    return activeTopics.filter((t) => focusedIds.has(t.id));
  }, [activeTopics, focusedTopicId]);

  // Auto-clear focus if focused topic disappears
  useEffect(() => {
    if (focusedTopicId && !activeTopics.some((t) => t.id === focusedTopicId)) {
      setFocusedTopicId(null);
    }
  }, [activeTopics, focusedTopicId]);

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

  // Render side panel content based on active view
  const renderSidePanel = () => {
    if (activeView === 'archive') {
      return (
        <ArchiveList
          archivedTopics={archivedTopics}
          onRestore={handleRestoreTopic}
          canRestoreTopics={can('topics.restore')}
        />
      );
    }

    const scopedSearchTopicId = focusedTopicId ?? activeTopicId;
    if (activeView === 'search') {
      return (
        <SearchPanel
          subtreeTopicId={scopedSearchTopicId}
          onOpenTopic={handleSelectTopic}
          onOpenMessage={handleOpenSearchMessage}
        />
      );
    }

    if (activeView === 'files') {
      return (
        <FilesystemExplorer
          selection={fileSelection}
          onSelect={setFileSelection}
          onNotify={notify}
        />
      );
    }

    // Default: topics view
    const focusTopic = focusedTopicId ? topics.find((t) => t.id === focusedTopicId) : null;
    return (
      <>
        {focusTopic && (
          <div className="focus-banner">
            <span>Focused on: <strong>{focusTopic.name}</strong></span>
            <button onClick={() => setFocusedTopicId(null)}>Show all</button>
          </div>
        )}
        <TopicTree
          topics={displayTopics}
          activeTopicId={activeTopicId}
          onSelectTopic={handleSelectTopic}
          onCreateTopic={handleCreateTopic}
          onArchiveTopic={handleArchiveTopic}
          onRenameTopic={handleRenameTopic}
          onFocusTopic={(id) => setFocusedTopicId(id)}
          onCreateChildTopic={(parentId) => {
            if (!can('topics.create')) return;
            const name = prompt('Child topic name:');
            if (!name) return;
            createTopic(name, parentId).then((topic) => {
              fetchTopics().then(setTopics);
              handleSelectTopic(topic.id);
            });
          }}
          focusedTopicId={focusedTopicId}
          canCreateTopics={can('topics.create')}
          canManageTopics={can('topics.rename') || can('topics.archive') || can('topics.move')}
        />
      </>
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
        canViewAdmin={can('admin.view')}
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
              className={`drawer-view-btn ${activeView === 'search' ? 'active' : ''}`}
              onClick={() => setActiveView(activeView === 'search' ? 'topics' : 'search')}
              aria-label="Search"
              title="Search"
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="M13 13l4 4" />
              </svg>
            </button>
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
            {can('admin.view') && (
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
        {presence.length > 0 && (
          <div className="presence-panel">
            <h3>Online now</h3>
            <ul className="presence-list">
              {presence.map((p) => (
                <li key={p.sessionId}>
                  <span className={`presence-dot ${p.state === 'idle' ? 'idle' : ''}`} />
                  <span className="presence-name">{p.displayName}</span>
                  <span className="presence-role">{p.role} · {p.state}</span>
                  <span className="presence-topic">
                    {p.activeTopicId
                      ? `#${p.activeTopicId} ${topics.find((t) => t.id === p.activeTopicId)?.name || ''}`
                      : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="user-section">
          <span className="user-handle">{authUser.handle}</span>
          <span className="user-role">{authUser.role}</span>
          {demoEnabled && authUser.isOwner && (
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
          {can('admin.view') && (
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
        {activeView === 'settings' && can('admin.view') ? (
          <AdminPage agents={agents} mode={project?.mode ?? 'private'} />
        ) : activeView === 'files' ? (
          fileSelection ? (
            <FilePreview
              selection={fileSelection}
              projectPath={project?.path}
              onOpenReference={(href) => {
                // Delegate to existing reference viewer mechanics by returning to topics
                setActiveView('topics');
                setTimeout(() => {
                  navigator.clipboard?.writeText(href).catch(() => {});
                  notify(`Reference URI copied: ${href}`, 'success');
                }, 0);
              }}
            />
          ) : (
            <div className="empty-state">
              <h2>Files</h2>
              <p>Select a file from the tree to preview its content.</p>
            </div>
          )
        ) : activeTopic ? (
          <ChatView
            topicId={activeTopic.id}
            topicName={activeTopic.name}
            messages={messages}
            onMenuToggle={() => setSidebarOpen(true)}
            agents={agents}
            commands={COMMANDS}
            activeJobs={activeJobs}
            inputRequests={activeInputRequests}
            currentUserId={authUser.id}
            onSend={handleSend}
            onAnswerInput={handleAnswerInput}
            onCancelInput={handleCancelInput}
            highlightedMessageId={highlightedMessageId}
            canCancelAnyInputRequest={can('input_requests.cancel.any')}
            canPromoteArtifacts={can('artifacts.promote')}
            projectPath={project?.path}
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
            {demoEnabled && authUser.isOwner && (
              <p>
                Demo mode is on. Press {demoHotkey} or click the Demo button to send the prompt sequence to
                {' '}{demoTopicName}.
              </p>
            )}
          </div>
        )}
      </main>
      {toast && (
        <div className={`toast toast-${toast.variant}`} role="status" aria-live="polite">
          <span className="toast-message">{toast.message}</span>
          <button className="toast-dismiss" onClick={() => setToast(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
