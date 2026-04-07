// Re-export everything from sub-modules — maintains backward compatibility
export { openDb } from './database.js';
export { SCHEMA } from './schema.js';
export { createUser, activateUser, getUser, getUserByHandle, listUsers, revokeUser } from './users.js';
export type { UserRow } from './users.js';
export { createTopic, getTopic, listTopics, setTopicLanguage, archiveTopic, listArchivedTopics, restoreTopic } from './topics.js';
export type { TopicRow } from './topics.js';
export { runMigrations } from './migrate.js';
export { insertMessage, getMessages, getRecentMessages, getMessageById, insertMention } from './messages.js';
export type { MessageRow } from './messages.js';
export { createBatch, createJob, updateJobStatus, getJobsForBatch, countChainJobs } from './jobs.js';
export { setPermission, getPermissions, setAlias, resolveAlias, getTopicAliases } from './permissions.js';
export { emitEvent, getEventsAfter, logUsage, countRecentJobs } from './events.js';
