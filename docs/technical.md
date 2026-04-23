# Technical documentation

## Architecture

The starter is split into three layers.

### 1. Workflow layer

File:

```text
.github/workflows/triage-bot.yml
```

Responsibilities:

- subscribe to GitHub events,
- prepare the runner,
- install Node.js dependencies,
- execute the engine script.

### 2. Configuration layer

File:

```text
.github/triage-rules.yml
```

Responsibilities:

- define aliases,
- define rules,
- define fallback/default actions,
- enable or disable `CODEOWNERS` integration,
- control defaults like inactivity threshold and dry run.

### 3. Engine layer

File:

```text
.github/scripts/triage-bot.js
```

Responsibilities:

- load and validate config,
- inspect the GitHub event,
- fetch current labels, comments, reviewers, and PR files,
- resolve aliases,
- evaluate conditions,
- execute matching actions,
- apply fallback if needed.

## Execution model

### Event-driven path

For `issues` and `pull_request` events:

1. Load config.
2. Read the current item from the GitHub event payload.
3. Fetch comments for idempotent marker checks.
4. Fetch PR changed files and requested reviewers when needed.
5. Parse `CODEOWNERS` if enabled.
6. Evaluate rules in order.
7. Execute actions for each matching rule.
8. If no rule matched, apply fallback for `issue` or `pull_request`.

### Schedule path

For `schedule.daily`:

1. List open issues and PRs in the repository.
2. Calculate inactivity age from `updated_at`.
3. Rebuild per-item runtime context.
4. Evaluate only rules subscribed to `schedule.daily`.
5. If no rule matched for an item, optionally apply fallback.

## Action semantics

### Labels

The engine uses GitHub `setLabels` after computing the desired final label set.

That means:

- `add_labels` adds missing labels,
- `remove_labels` removes configured labels,
- `set_labels.remove_matching` removes labels matching wildcard patterns,
- `set_labels.add` adds the replacement labels.

This is intentionally deterministic.

### Assignees

Assignee changes are additive in v1.

The engine currently:

- resolves aliases to GitHub usernames,
- adds missing assignees,
- leaves existing assignees untouched.

### Reviewers

PR reviewers are requested additively.

The engine currently supports:

- explicit user reviewers,
- explicit team reviewers through alias type `team`,
- reviewer sync from `CODEOWNERS` results.

### Comments

Comments can be guarded by `comment_once_key`.

Implementation detail:

- the engine inserts a hidden HTML comment marker,
- before posting, it scans existing issue comments,
- if the marker exists, the comment is skipped.

## Alias resolution order

Resolution order is:

1. alias from config,
2. built-in alias,
3. literal token.

That means `repo_owner` is built-in, but can still be overridden in config.

## `CODEOWNERS` strategy

This starter uses a lightweight parser.

Important notes:

- it is intended for practical routing rather than perfect replication of every GitHub edge case,
- last matching pattern wins,
- changed files are matched against the parsed entries,
- owners are converted into user or team reviewer requests.

This is good enough for most internal automation use cases.

## Logging

The engine writes execution logs to standard output.

Examples:

- matched rule names,
- alias override notices,
- dry-run operations,
- fallback execution,
- skipped duplicate comments.

## Error handling

The engine fails the workflow when:

- config cannot be parsed,
- config version is unsupported,
- `GITHUB_TOKEN` is missing,
- an unsupported alias type is used,
- a team alias is used for a non-reviewer action.

## Security notes

Recommended permissions for the workflow:

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: write
```

Do not grant broader permissions unless you add features that require them.

## Extension points

This repository is designed so you can add features without rewriting the whole engine.

Good extension points:

- new conditions in `evaluateConditionObject()`,
- new alias types in `resolveAliasDefinition()`,
- new actions in `executeActions()`,
- stronger config validation,
- JSON Schema generation,
- test fixtures and mocked GitHub API tests.

## Suggested roadmap

### v1.1

- JSON Schema for `.github/triage-rules.yml`
- test suite for event fixtures
- `assign_mode: round_robin`

### v1.2

- nested boolean conditions
- milestone and project field actions
- better `CODEOWNERS` coverage

### v1.3

- reusable organization-wide action package
- shared preset configs
- audit summary comment or artifact output
