import { describe, expect, it } from 'vitest';
import { openDb } from './database.js';
import { createTopic } from './topics.js';
import { getMessagesAround, insertMessage } from './messages.js';
import { searchAll } from './search.js';

describe('searchAll', () => {
  it('returns grouped topic and message results', () => {
    const db = openDb(':memory:');
    const parentId = createTopic(db, 'Payment refactor');
    const childId = createTopic(db, 'Webhook retry', parentId);
    insertMessage(db, childId, 'user', 'owner', 'Stripe webhook retry fails after duplicate delivery');

    const results = searchAll(db, 'webhook retry');

    expect(results.topics.map((topic) => topic.topicName)).toContain('Webhook retry');
    expect(results.messages).toHaveLength(1);
    expect(results.messages[0]).toMatchObject({
      topicId: childId,
      topicPath: 'Payment refactor / Webhook retry',
      authorName: 'owner',
    });

    db.close();
  });

  it('can restrict message search to a subtree', () => {
    const db = openDb(':memory:');
    const bugsId = createTopic(db, 'Bugs');
    const bugId = createTopic(db, 'Webhook bug', bugsId);
    const ideasId = createTopic(db, 'Ideas');
    insertMessage(db, bugId, 'user', 'owner', 'webhook timeout in retries');
    insertMessage(db, ideasId, 'user', 'owner', 'webhook dashboard idea');

    const results = searchAll(db, 'webhook', 'messages', {
      scope: 'subtree',
      topicId: bugsId,
    });

    expect(results.messages).toHaveLength(1);
    expect(results.messages[0].topicId).toBe(bugId);

    db.close();
  });
});

describe('getMessagesAround', () => {
  it('returns context before and after the target message', () => {
    const db = openDb(':memory:');
    const topicId = createTopic(db, 'Long thread');
    const ids = [
      insertMessage(db, topicId, 'user', 'owner', 'first'),
      insertMessage(db, topicId, 'user', 'owner', 'second'),
      insertMessage(db, topicId, 'user', 'owner', 'third'),
      insertMessage(db, topicId, 'user', 'owner', 'fourth'),
      insertMessage(db, topicId, 'user', 'owner', 'fifth'),
    ];

    const messages = getMessagesAround(db, topicId, ids[2], 1);

    expect(messages?.map((message) => message.body)).toEqual(['second', 'third', 'fourth']);
    db.close();
  });
});
