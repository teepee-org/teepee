// Re-export everything from sub-modules — maintains backward compatibility
export { openDb } from './database.js';
export { SCHEMA } from './schema.js';
export { createUser, activateUser, getUser, getUserById, getUserByHandle, listUsers, revokeUser, normalizeUserRole } from './users.js';
export type { UserRow } from './users.js';
export { createTopic, getTopic, listTopics, setTopicLanguage, archiveTopic, listArchivedTopics, restoreTopic, isAncestorOf, moveTopicToRoot, moveTopicInto, moveTopicBefore, moveTopicAfter, getTopicLineage, renameTopic } from './topics.js';
export type { TopicRow } from './topics.js';
export { runMigrations } from './migrate.js';
export { insertMessage, getMessages, getRecentMessages, getMessageById, getMessageByClientMessageId, getMessagesAround, insertMention } from './messages.js';
export type { MessageRow } from './messages.js';
export { searchAll, searchTopics, searchMessages } from './search.js';
export type { SearchScope, SearchType, SearchOptions, SearchResponse, TopicSearchResult, MessageSearchResult } from './search.js';
export { createBatch, createJob, updateJobStatus, markJobWaitingInput, markJobResumed, cancelJob, getJob, getJobsForBatch, listActiveJobsForTopic, countActiveJobsByTopic, failInterruptedJobs, countChainJobs } from './jobs.js';
export { setPermission, getPermissions, setAlias, resolveAlias, getTopicAliases } from './permissions.js';
export { emitEvent, getEventsAfter, logUsage, countRecentJobs } from './events.js';
export {
  createDocumentArtifact,
  updateDocumentArtifact,
  listTopicArtifacts,
  searchArtifacts,
  getArtifact,
  getArtifactVersions,
  getArtifactVersion,
  getArtifactVersionByNumber,
  getCurrentArtifactVersion,
  linkMessageArtifact,
  getMessageArtifacts,
  getEnrichedMessageArtifacts,
  promoteArtifact,
  listTopicArtifactContext,
  listScopedArtifactContext,
  listScopedArtifacts,
  searchScopedArtifacts,
  countArtifactsByTopic,
  restoreDocumentArtifact,
  rewriteDocumentArtifactFromVersion,
  ArtifactConflictError,
} from './artifacts.js';
export type {
  ArtifactRow,
  ArtifactVersionRow,
  MessageArtifactRow,
  EnrichedMessageArtifact,
  ArtifactContextInfo,
  ScopedArtifactContextInfo,
  CreateDocumentArtifactParams,
  UpdateDocumentArtifactParams,
  RestoreDocumentArtifactParams,
  RewriteDocumentArtifactFromVersionParams,
  CreateArtifactResult,
  UpdateArtifactResult,
} from './artifacts.js';
