import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MessageSearchResult, SearchResponse, TopicSearchResult } from 'teepee-core';
import { searchTeepee } from '../api';

interface Props {
  subtreeTopicId: number | null;
  onOpenTopic: (topicId: number) => void;
  onOpenMessage: (result: MessageSearchResult) => void;
}

const EMPTY_RESULTS: SearchResponse = { query: '', topics: [], messages: [] };

export function SearchPanel({ subtreeTopicId, onOpenTopic, onOpenMessage }: Props) {
  const [query, setQuery] = useState('');
  const [useSubtree, setUseSubtree] = useState(false);
  const [results, setResults] = useState<SearchResponse>(EMPTY_RESULTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedQuery = query.trim();
  const canUseSubtree = subtreeTopicId != null;
  const effectiveSubtree = canUseSubtree && useSubtree;

  useEffect(() => {
    if (!canUseSubtree && useSubtree) {
      setUseSubtree(false);
    }
  }, [canUseSubtree, useSubtree]);

  useEffect(() => {
    let cancelled = false;

    if (trimmedQuery.length < 2) {
      setResults(EMPTY_RESULTS);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const timeout = window.setTimeout(() => {
      searchTeepee({
        q: trimmedQuery,
        scope: effectiveSubtree ? 'subtree' : 'all',
        topicId: effectiveSubtree ? subtreeTopicId : null,
        limit: 20,
      })
        .then((nextResults) => {
          if (!cancelled) setResults(nextResults);
        })
        .catch((err: any) => {
          if (!cancelled) {
            setResults(EMPTY_RESULTS);
            setError(err?.message || 'Search failed');
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [effectiveSubtree, subtreeTopicId, trimmedQuery]);

  const hasResults = results.topics.length > 0 || results.messages.length > 0;
  const status = useMemo(() => {
    if (trimmedQuery.length < 2) return null;
    if (loading) return 'Searching...';
    if (error) return error;
    if (!hasResults) return 'No results';
    return null;
  }, [error, hasResults, loading, trimmedQuery.length]);

  return (
    <div className="search-panel">
      <label className="search-label" htmlFor="teepee-search">Search</label>
      <input
        id="teepee-search"
        className="search-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search topics and messages"
      />
      <label className={`search-scope ${canUseSubtree ? '' : 'disabled'}`}>
        <input
          type="checkbox"
          checked={effectiveSubtree}
          disabled={!canUseSubtree}
          onChange={(event) => setUseSubtree(event.target.checked)}
        />
        Current subtree
      </label>

      {status && <div className={`search-status ${error ? 'error' : ''}`}>{status}</div>}

      {hasResults && (
        <div className="search-results">
          {results.topics.length > 0 && (
            <SearchGroup title="Topics">
              {results.topics.map((result) => (
                <TopicSearchItem
                  key={result.topicId}
                  result={result}
                  onOpenTopic={onOpenTopic}
                />
              ))}
            </SearchGroup>
          )}

          {results.messages.length > 0 && (
            <SearchGroup title="Messages">
              {results.messages.map((result) => (
                <MessageSearchItem
                  key={result.messageId}
                  result={result}
                  onOpenMessage={onOpenMessage}
                />
              ))}
            </SearchGroup>
          )}
        </div>
      )}
    </div>
  );
}

function SearchGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="search-group">
      <h3>{title}</h3>
      <div className="search-group-items">{children}</div>
    </section>
  );
}

function TopicSearchItem({
  result,
  onOpenTopic,
}: {
  result: TopicSearchResult;
  onOpenTopic: (topicId: number) => void;
}) {
  return (
    <button className="search-result" onClick={() => onOpenTopic(result.topicId)}>
      <span className="search-result-title">{result.topicName}</span>
      <span className="search-result-path">{result.topicPath}</span>
    </button>
  );
}

function MessageSearchItem({
  result,
  onOpenMessage,
}: {
  result: MessageSearchResult;
  onOpenMessage: (result: MessageSearchResult) => void;
}) {
  return (
    <button className="search-result" onClick={() => onOpenMessage(result)}>
      <span className="search-result-title">
        {result.authorName}
        <span className="search-result-date">{new Date(result.createdAt).toLocaleString()}</span>
      </span>
      <span className="search-result-snippet">{result.excerpt}</span>
      <span className="search-result-path">{result.topicPath}</span>
    </button>
  );
}
