# Future Direction: Hierarchical Topic Context and Topic Summaries

## Goal

Extend Teepee's topic model so topic hierarchy is not only a lightweight organizational feature, but can also support shared context and controlled summarization across workstreams.

This should remain domain-agnostic.
The design must work not only for software development, but also for legal, consulting, finance, operations, research, and other collaborative workflows.

## 1. Hierarchy First, Containers Never

The preferred model is:

- every node is a topic
- a topic may optionally have child topics
- there is no separate "container" entity

This keeps the product model simple:

- one concept to explain
- one permission model
- one interaction pattern
- future features can build on the same primitive

## 2. Parent Topics as Optional Shared Context

Hierarchy should not automatically imply context inheritance.

Some parent topics are just structural grouping:

- `Q2 planning`
- `Client X`
- `Release 0.3`

Others may contain instructions, constraints, goals, or reference material that should be relevant to child topics.

Because of that, context inheritance should be explicit.

### Proposed topic-level flag

Each topic can optionally expose a boolean flag such as:

- `use_as_context_for_children`

Possible user-facing labels:

- `Use as context for child topics`
- `Shared context for children`
- `Relevant as context for child topics`

### Why make it explicit

This avoids hidden behavior and keeps hierarchy lightweight by default.

Without an explicit flag:

- users may be surprised that child topic behavior changes
- prompts may become noisy
- it becomes unclear whether a parent topic is organizational or instructional

With an explicit flag:

- hierarchy remains useful even when purely structural
- inheritance becomes intentional
- future prompt construction stays explainable

## 3. Context Inheritance Should Be Selective, Not Full Thread Inheritance

Child topics should not automatically inherit the full raw message history of their parent topics.

That would create:

- too much prompt noise
- unclear relevance
- excessive token growth
- brittle behavior across domains

Instead, inherited context should eventually come from controlled inputs such as:

- topic instructions
- a canonical topic summary
- curated/pinned context messages

This is especially important outside coding workflows.

Examples:

- legal: scope, jurisdiction, assumptions, relevant documents
- consulting: client goals, agreed framing, timeline, stakeholders
- finance: portfolio constraints, risk tolerance, reporting requirements
- operations: procedures, environment assumptions, approval rules

## 4. Topic Summary as a First-Class Primitive

A topic summary is a high-value feature.

The important idea is not "coding summary", but "canonical shared summary of a topic's state".

This is useful across domains:

- summarize a negotiation
- summarize a legal review
- summarize a consulting thread
- summarize an operations incident
- summarize a long-running implementation topic

### Recommended V1 behavior

Introduce a topic summarization action such as:

- `/topic summarize`

The result should be:

- a new summary message added to the topic
- existing history remains intact
- no destructive rewrite of the thread

This summary can later become the preferred context anchor.

### Why not rewrite the thread itself

Replacing the whole thread immediately is too aggressive.

It risks:

- losing nuance
- making audit/history harder
- over-optimizing too early

The better first step is:

- preserve the full thread
- add a canonical summary message
- optionally mark it as the latest summary

## 5. Suggested Summary Structure

The summary should remain domain-neutral.

A useful generic shape could include:

- purpose
- current state
- key decisions
- assumptions or constraints
- open questions
- next steps

This structure can work for coding, legal, consulting, finance, and other areas.

## 6. Long-Term Interaction Between Hierarchy and Summaries

The strongest product direction is likely:

1. hierarchy for lightweight structure
2. explicit parent context flag
3. topic summaries as reusable context
4. child topics inherit summary/instructions, not raw parent history

In practice:

- a parent topic may organize related work
- if marked as shared context, it can provide stable background
- that background should come from an explicit summary or instructions
- child topics then remain focused and cheap to prompt

## 7. Recommended Incremental Roadmap

### Phase 1

Ship hierarchy only:

- parent-child topics
- sibling ordering
- minimal visual indentation

### Phase 2

Add parent metadata to agent context:

- current topic
- parent topic
- optional topic path

This is low-risk and gives agents better orientation.

### Phase 3

Add explicit parent context flag:

- topic can be marked as shared context for children

No full inheritance yet.

### Phase 4

Add topic summaries:

- `/topic summarize`
- canonical summary message
- latest summary reference stored in topic metadata if useful

### Phase 5

Use summary/instructions as inherited child context:

- only if parent topic is explicitly marked as shared context
- do not inherit full raw parent thread

## 8. Product Principle

The key principle is:

hierarchy should stay almost invisible in the UI, but become strategically powerful in the context model.

That means:

- lightweight organization for users
- explicit context control
- summary-driven inheritance
- domain-neutral design

This direction preserves Teepee's simplicity while making topics more useful as reusable collaborative units.
