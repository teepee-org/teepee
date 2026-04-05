import { describe, it, expect } from 'vitest';
import { parseMentions } from './mentions.js';

describe('parseMentions', () => {
  it('parses single active mention', () => {
    const result = parseMentions('@coder hello');
    expect(result.active).toEqual(['coder']);
    expect(result.quoted).toEqual([]);
  });

  it('parses multiple active mentions', () => {
    const result = parseMentions('@coder @reviewer cosa ne pensate?');
    expect(result.active).toEqual(['coder', 'reviewer']);
  });

  it('deduplicates mentions', () => {
    const result = parseMentions('@coder @coder hello');
    expect(result.active).toEqual(['coder']);
  });

  it('treats double-quoted mentions as quoted', () => {
    const result = parseMentions('scrivi task per "@reviewer"');
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual(['reviewer']);
  });

  it('treats single-quoted mentions as quoted', () => {
    const result = parseMentions("scrivi task per '@reviewer'");
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual(['reviewer']);
  });

  it('mixed active and quoted', () => {
    const result = parseMentions('@coder scrivi task per "@reviewer"');
    expect(result.active).toEqual(['coder']);
    expect(result.quoted).toEqual(['reviewer']);
  });

  it('ignores escaped mentions', () => {
    const result = parseMentions('\\@coder hello');
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual([]);
  });

  it('ignores inline code mentions', () => {
    const result = parseMentions('use `@coder` for coding');
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual([]);
  });

  it('ignores code block mentions', () => {
    const result = parseMentions('```\n@coder hello\n```');
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual([]);
  });

  it('handles code block with language', () => {
    const result = parseMentions('```python\n@coder hello\n```');
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual([]);
  });

  it('active mention before code block', () => {
    const result = parseMentions('@coder look at this:\n```\n@reviewer\n```');
    expect(result.active).toEqual(['coder']);
    expect(result.quoted).toEqual([]);
  });

  it('handles agent names with hyphens', () => {
    const result = parseMentions('@code-reviewer check this');
    expect(result.active).toEqual(['code-reviewer']);
  });

  it('handles agent names with underscores', () => {
    const result = parseMentions('@my_agent check this');
    expect(result.active).toEqual(['my_agent']);
  });

  it('stops at non-name characters', () => {
    const result = parseMentions('@coder, please check');
    expect(result.active).toEqual(['coder']);
  });

  it('returns empty for no mentions', () => {
    const result = parseMentions('hello world');
    expect(result.active).toEqual([]);
    expect(result.quoted).toEqual([]);
  });

  it('handles @ alone', () => {
    const result = parseMentions('email me @ test');
    expect(result.active).toEqual([]);
  });

  it('canonical example: active + quoted', () => {
    const result = parseMentions('@agent1 scrivi un task per "@agent2"');
    expect(result.active).toEqual(['agent1']);
    expect(result.quoted).toEqual(['agent2']);
  });
});
