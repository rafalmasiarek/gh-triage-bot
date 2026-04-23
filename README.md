# GitHub Triage Bot Starter

Config-driven GitHub triage bot for issues and pull requests.

This starter repository gives you:

- one GitHub Actions workflow,
- one triage engine written in Node.js,
- one YAML config file for rules,
- optional `CODEOWNERS` integration,
- fallback/default routing,
- labels, assignees, reviewers, comments,
- 30-day inactivity reminders.

## Features

- Assign issues by labels, title, body, inactivity, or fallback.
- Label issues and PRs with `add_labels`, `remove_labels`, and scoped `set_labels`.
- Request PR reviewers from explicit rules or from `CODEOWNERS`.
- Add idempotent comments with `comment_once_key` markers.
- Support built-in aliases like `@repo_owner`, with optional config override.
- Run on issue events, PR events, manual dispatch, and daily schedule.

## Repository layout

```text
.github/
  CODEOWNERS
  triage-rules.yml
  workflows/
    triage-bot.yml
  scripts/
    triage-bot.js
docs/
  technical.md
package.json
README.md
```

## Quick start

1. Copy this repository into your project.
2. Update `.github/triage-rules.yml`.
3. Update `.github/CODEOWNERS` if you want path-based ownership.
4. Commit and push.
5. Open an issue or PR.

## Workflow

The workflow file is `.github/workflows/triage-bot.yml`.

It runs on:

- issue events,
- pull request events,
- a daily cron schedule,
- manual `workflow_dispatch`.

It uses the default `GITHUB_TOKEN` and requires these permissions:

```yaml
permissions:
  contents: read
  issues: write
  pull-requests: write
```

## Configuration

Main config file:

```text
.github/triage-rules.yml
```

### Top-level structure

```yaml
version: 1

defaults:
  dry_run: false
  inactivity_days: 30
  reminder_label: reminded-30d
  comment_marker_prefix: triage-bot

codeowners:
  enabled: true
  mode: augment
  path: .github/CODEOWNERS

aliases:
  repo_owner:
    type: users
    users: [octocat]

rules: []

fallback:
  issue: {}
  pull_request: {}
```

## Built-in aliases

These aliases work without configuration:

- `@repo_owner`
- `@repo_name`
- `@repo_full_name`
- `@issue_author`
- `@pr_author`
- `@author`
- `@actor`
- `@assignees`
- `@requested_reviewers`

### Overriding built-in aliases

Built-in aliases can be overridden in `aliases`.

Example:

```yaml
aliases:
  repo_owner:
    type: users
    users:
      - alice
      - bob
```

That is useful for organization repositories where the literal repository owner is not a good routing target.

## Supported alias types

### Users

```yaml
aliases:
  maintainers:
    type: users
    users:
      - alice
      - bob
```

### Team

Team aliases can be used for PR reviewer requests.

```yaml
aliases:
  backend_team:
    type: team
    team: myorg/backend
```

### Dynamic aliases

```yaml
aliases:
  repo_owner:
    type: repo_owner
```

Supported dynamic alias types in this starter:

- `repo_owner`
- `issue_author`
- `pr_author`

## Rule model

Rules are checked in order.

A rule has:

- `name`
- `enabled`
- `on`
- `if`
- `then`
- optional `stop`

Example:

```yaml
- name: label-docs-prs
  enabled: true
  on:
    - pull_request.opened
    - pull_request.synchronize
  if:
    type: pull_request
    changed_files_any:
      - docs/**
      - '**/*.md'
  then:
    add_labels: [documentation]
    request_reviewers: ['@repo_owner']
```

## Supported conditions

This starter engine supports:

- `type`: `issue` or `pull_request`
- `state`: usually `open`
- `assignee_missing: true`
- `assignee_present: true`
- `labels_any`
- `labels_all`
- `labels_none`
- `title_matches`
- `body_matches`
- `actor_not`
- `draft`
- `days_inactive_gt`
- `changed_files_any`
- `changed_files_all`
- `changed_files_none`
- `codeowners_match`

## Supported actions

### Assign issue assignees

```yaml
then:
  assign: ['@repo_owner']
```

### Request PR reviewers

```yaml
then:
  request_reviewers:
    - '@repo_owner'
    - '@backend_team'
```

### Add labels

```yaml
then:
  add_labels: [triaged, backend]
```

### Remove labels

```yaml
then:
  remove_labels: [needs-triage]
```

### Scoped `set_labels`

This is the recommended v1 format.

```yaml
then:
  set_labels:
    remove_matching: ['type:*', 'area:*']
    add: ['type:bug', 'area:api']
```

Semantics:

- remove all labels matching `remove_matching`,
- add labels from `add`,
- keep all other labels untouched.

### Idempotent comments

```yaml
then:
  comment_once_key: inactive-30d
  comment: |
    Ping @{assignees} — this item has been inactive for @{age_days} days.
```

The engine stores a hidden marker in the comment body:

```html
<!-- triage-bot:inactive-30d -->
```

That prevents duplicate comments.

### Sync reviewers from `CODEOWNERS`

```yaml
then:
  sync_reviewers_from_codeowners: true
```

## `CODEOWNERS` integration

This starter can parse `.github/CODEOWNERS` and resolve owners for changed PR files.

Config:

```yaml
codeowners:
  enabled: true
  mode: augment
  path: .github/CODEOWNERS
```

Current implementation notes:

- It reads the configured file from the checked out repository.
- It matches changed PR files using glob-like patterns.
- User owners are requested as individual reviewers.
- Team owners written as `@org/team` are requested as team reviewers.
- It does not replace GitHub's native `CODEOWNERS` behavior; it complements it.

Recommended usage:

- Keep `CODEOWNERS` as the source of truth for code ownership.
- Use triage rules for labels, assignees, comments, reminders, and fallback routing.

## Fallback/default actions

Fallback is applied when no normal rule matched the current item.

Example:

```yaml
fallback:
  issue:
    add_labels: [needs-triage]
    assign: ['@repo_owner']
    comment_once_key: fallback-issue
    comment: |
      No specific rule matched, so this issue was routed to @{assignees}.

  pull_request:
    add_labels: [needs-triage]
    request_reviewers: ['@repo_owner']
```

This is the recommended way to implement a default action with the lowest priority.

## Dry run

You can run the workflow manually and set `dry_run=true` through `workflow_dispatch`.

The engine also supports config-level dry run:

```yaml
defaults:
  dry_run: true
```

In dry run mode, the engine logs intended actions and does not write to GitHub.

## Local validation

Install dependencies:

```bash
npm ci
```

Validate the config:

```bash
npm run validate-config
```

## Notes and limitations

- Team aliases are supported only for PR reviewer requests.
- Assignee assignment expects GitHub users, not organizations.
- The schedule job scans open issues and PRs in the current repository.
- This starter keeps the engine intentionally compact and readable rather than over-engineered.

## Recommended next improvements

- JSON Schema for the YAML config
- round-robin assignment mode
- richer logical expressions (`any`, `all`, `not`)
- organization-level maintainer discovery
- test suite with fixture events
- stronger `CODEOWNERS` compatibility tests

## License

Use this starter as a base for your own repository automation.
