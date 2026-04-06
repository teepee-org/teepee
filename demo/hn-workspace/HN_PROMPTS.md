# HN Demo Prompts

Use these from inside the demo workspace.

## 1. Quick intro

```text
@coder @reviewer @architect introduce yourselves in one short paragraph each.
```

## 2. Review-first workflow

```text
@reviewer review this demo codebase. Give me 3 concrete findings ordered by severity, with file references.
```

## 3. Architect hands work to coder

```text
@architect design a `--format markdown` feature for the CLI report. Be specific about files, functions, tests, and acceptance criteria, then assign it to @coder.
```

## 4. Coder implements a real change

```text
@coder implement `--format markdown` for this workspace, update tests, run them, and report exactly what changed.
```

## 5. Parallel agents

```text
@reviewer find two weaknesses in the current code. @architect propose one small but worthwhile feature for this workspace.
```

## 6. Delegation without accidental trigger

```text
@architect propose a plan for adding an owner filter to the CLI. Mention "@coder" only as a reference, not as an active handoff.
```

## 7. Full handoff demo

```text
@architect design a `--owner <name>` CLI filter for this workspace and explicitly tag @coder to implement it.
```

## 8. Verify blocked vs completed steps

```text
@coder add a `--severity <level>` filter, run tests, and clearly separate applied edits from any blocked verification steps.
```
