#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import yaml from 'js-yaml';
import * as core from '@actions/core';
import { minimatch } from 'minimatch';
import { getOctokit, context } from '@actions/github';

const DEFAULT_COMMENT_MARKER_PREFIX = 'triage-bot';
const BUILTIN_ALIAS_FACTORIES = {
  repo_owner: (ctx) => [ctx.repo.owner],
  repo_name: (ctx) => [ctx.repo.repo],
  repo_full_name: (ctx) => [`${ctx.repo.owner}/${ctx.repo.repo}`],
  issue_author: (ctx) => (ctx.item?.user?.login ? [ctx.item.user.login] : []),
  pr_author: (ctx) => (ctx.item?.user?.login ? [ctx.item.user.login] : []),
  author: (ctx) => (ctx.item?.user?.login ? [ctx.item.user.login] : []),
  actor: (ctx) => (ctx.actor ? [ctx.actor] : []),
  assignees: (ctx) => (ctx.item?.assignees || []).map((a) => a.login),
  requested_reviewers: (ctx) => [
    ...((ctx.prState?.requestedReviewers || []).map((u) => u.login)),
    ...((ctx.prState?.requestedTeams || []).map((t) => `${t.org}/${t.slug}`)),
  ],
};

function readYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isTruthyString(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function getEventName(ctx) {
  if (ctx.eventName === 'issues') return `issues.${ctx.payload.action}`;
  if (ctx.eventName === 'pull_request') return `pull_request.${ctx.payload.action}`;
  if (ctx.eventName === 'schedule') return 'schedule.daily';
  if (ctx.eventName === 'workflow_dispatch') return 'workflow_dispatch';
  return `${ctx.eventName}.${ctx.payload.action || 'unknown'}`;
}

function getItemType(ctx) {
  if (ctx.payload.pull_request || ctx.eventName === 'pull_request') return 'pull_request';
  if (ctx.payload.issue || ctx.eventName === 'issues') return 'issue';
  return 'none';
}

function getTrackedItem(ctx) {
  return ctx.payload.pull_request || ctx.payload.issue || null;
}

function compileRegex(pattern) {
  if (!pattern) return null;
  const slashRegex = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
  if (slashRegex) return new RegExp(slashRegex[1], slashRegex[2]);
  return new RegExp(pattern);
}

function matchAnyPattern(values, patterns) {
  return values.some((value) => patterns.some((pattern) => minimatch(value, pattern, { dot: true })));
}

function matchLabelPatterns(labels, patterns) {
  return labels.filter((label) => patterns.some((pattern) => minimatch(label, pattern)));
}

function renderTemplate(template, renderContext) {
  if (!template) return '';
  return template.replace(/@\{([a-zA-Z0-9_]+)\}/g, (_m, key) => {
    const value = renderContext[key];
    if (Array.isArray(value)) return value.length ? value.map((v) => `@${v}`).join(', ') : '(none)';
    if (value === undefined || value === null || value === '') return '(none)';
    return String(value);
  });
}

function resolveAliasToken(token, runtime, purpose = 'generic') {
  if (!token.startsWith('@')) return [token];
  const aliasName = token.slice(1);
  const override = runtime.config.aliases?.[aliasName];
  if (override) {
    runtime.logs.push(`Alias '${aliasName}' resolved from config override.`);
    return resolveAliasDefinition(override, runtime, purpose);
  }
  if (BUILTIN_ALIAS_FACTORIES[aliasName]) {
    return BUILTIN_ALIAS_FACTORIES[aliasName](runtime.ctx);
  }
  return [aliasName];
}

function resolveAliasDefinition(def, runtime, purpose = 'generic') {
  if (!def || typeof def !== 'object') return [];
  switch (def.type) {
    case 'users':
      return uniq(
        (def.users || [])
          .flatMap((u) => resolveAliasToken(u.startsWith('@') ? u : `@${u}`, runtime, purpose))
          .map(stripAt),
      );
    case 'repo_owner':
      return BUILTIN_ALIAS_FACTORIES.repo_owner(runtime.ctx);
    case 'issue_author':
      return BUILTIN_ALIAS_FACTORIES.issue_author(runtime.ctx);
    case 'pr_author':
      return BUILTIN_ALIAS_FACTORIES.pr_author(runtime.ctx);
    case 'team':
      if (purpose === 'reviewers') return [def.team];
      throw new Error(`Alias of type 'team' can only be used for reviewers: ${def.team}`);
    default:
      throw new Error(`Unsupported alias type: ${def.type}`);
  }
}

function stripAt(value) {
  return String(value).replace(/^@/, '');
}

function resolveTargets(values, runtime, purpose = 'generic') {
  const resolved = [];
  for (const value of toArray(values)) {
    const token = String(value);
    if (token.startsWith('@')) {
      for (const item of resolveAliasToken(token, runtime, purpose)) {
        resolved.push(stripAt(item));
      }
    } else {
      resolved.push(stripAt(token));
    }
  }
  return uniq(resolved);
}

async function listPullRequestFiles(octokit, repo, pullNumber) {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: repo.owner,
    repo: repo.repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files.map((f) => f.filename);
}

async function listIssueComments(octokit, repo, issueNumber) {
  return octokit.paginate(octokit.rest.issues.listComments, {
    owner: repo.owner,
    repo: repo.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

async function getRequestedReviewers(octokit, repo, pullNumber) {
  const result = await octokit.rest.pulls.listRequestedReviewers({
    owner: repo.owner,
    repo: repo.repo,
    pull_number: pullNumber,
  });
  return {
    users: result.data.users || [],
    teams: result.data.teams || [],
  };
}

function parseCodeownersFile(filePath) {
  if (!fileExists(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const entries = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    entries.push({ pattern: parts[0], owners: parts.slice(1).map(stripAt) });
  }
  return entries;
}

function matchCodeowners(entries, files) {
  const matchedOwners = [];
  for (const file of files) {
    let matched = null;
    for (const entry of entries) {
      const normalizedPattern = entry.pattern.startsWith('/') ? entry.pattern.slice(1) : entry.pattern;
      if (minimatch(file, normalizedPattern, { dot: true, matchBase: true })) {
        matched = entry;
      }
    }
    if (matched) matchedOwners.push(...matched.owners);
  }
  return uniq(matchedOwners);
}

function buildRenderContext(runtime) {
  const labels = (runtime.ctx.item?.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
  return {
    repo_owner: runtime.ctx.repo.owner,
    repo_name: runtime.ctx.repo.repo,
    repo_full_name: `${runtime.ctx.repo.owner}/${runtime.ctx.repo.repo}`,
    author: runtime.ctx.item?.user?.login || '',
    issue_author: runtime.ctx.item?.user?.login || '',
    pr_author: runtime.ctx.item?.user?.login || '',
    assignees: (runtime.ctx.item?.assignees || []).map((a) => a.login),
    requested_reviewers: [
      ...runtime.prState.requestedReviewers.map((u) => u.login),
      ...runtime.prState.requestedTeams.map((t) => `${t.org}/${t.slug}`),
    ],
    codeowners_reviewers: runtime.codeownersOwners,
    labels,
    title: runtime.ctx.item?.title || '',
    number: runtime.ctx.item?.number || '',
    url: runtime.ctx.item?.html_url || '',
    age_days: runtime.ageDays,
  };
}

function hasCommentMarker(comments, marker) {
  return comments.some((comment) => (comment.body || '').includes(marker));
}

function buildMarker(prefix, key) {
  return `<!-- ${prefix}:${key} -->`;
}

function getLabels(item) {
  return (item?.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
}

function evaluateConditionObject(cond, runtime) {
  if (!cond || typeof cond !== 'object') return true;

  const item = runtime.ctx.item;
  const labels = getLabels(item);
  const body = item?.body || '';
  const title = item?.title || '';
  const type = runtime.ctx.itemType;

  const assignees = (item?.assignees || []).map((a) => a.login);
  const requestedReviewerUsers = (runtime.prState?.requestedReviewers || []).map((u) => u.login);
  const requestedReviewerTeams = (runtime.prState?.requestedTeams || []).map((t) => `${t.org}/${t.slug}`);
  const requestedReviewers = [...requestedReviewerUsers, ...requestedReviewerTeams];

  const author = item?.user?.login || '';
  const createdAt = item?.created_at ? new Date(item.created_at) : null;
  const createdDays = createdAt
    ? Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const branchName = runtime.ctx.itemType === 'pull_request'
    ? item?.head?.ref || ''
    : '';

  const baseBranch = runtime.ctx.itemType === 'pull_request'
    ? item?.base?.ref || ''
    : '';

  const commentCount = Array.isArray(runtime.comments) ? runtime.comments.length : 0;

  if (cond.type && cond.type !== type) return false;
  if (cond.state && item?.state !== cond.state) return false;

  if (cond.assignee_missing === true && assignees.length > 0) return false;
  if (cond.assignee_present === true && assignees.length === 0) return false;

  if (cond.label_missing === true && labels.length > 0) return false;
  if (cond.label_present === true && labels.length === 0) return false;

  if (cond.label_count_eq !== undefined && labels.length !== Number(cond.label_count_eq)) return false;
  if (cond.label_count_lt !== undefined && !(labels.length < Number(cond.label_count_lt))) return false;
  if (cond.label_count_gt !== undefined && !(labels.length > Number(cond.label_count_gt))) return false;

  if (cond.labels_any && !labels.some((label) => cond.labels_any.includes(label))) return false;
  if (cond.labels_all && !cond.labels_all.every((label) => labels.includes(label))) return false;
  if (cond.labels_none && labels.some((label) => cond.labels_none.includes(label))) return false;

  if (
    cond.labels_match &&
    !labels.some((label) =>
      cond.labels_match.some((pattern) => minimatch(label, pattern, { dot: true }))
    )
  ) return false;

  if (cond.title_matches && !compileRegex(cond.title_matches).test(title)) return false;
  if (cond.body_matches && !compileRegex(cond.body_matches).test(body)) return false;

  if (cond.body_missing === true && body.trim().length > 0) return false;
  if (cond.body_missing === false && body.trim().length === 0) return false;

  if (cond.body_length_lt !== undefined && !(body.trim().length < Number(cond.body_length_lt))) return false;
  if (cond.body_length_gt !== undefined && !(body.trim().length > Number(cond.body_length_gt))) return false;

  if (cond.title_length_lt !== undefined && !(title.trim().length < Number(cond.title_length_lt))) return false;
  if (cond.title_length_gt !== undefined && !(title.trim().length > Number(cond.title_length_gt))) return false;

  if (cond.actor_not && runtime.ctx.actor === stripAt(cond.actor_not)) return false;
  if (cond.actor_is && runtime.ctx.actor !== stripAt(cond.actor_is)) return false;

  if (cond.author_is && author !== stripAt(cond.author_is)) return false;
  if (cond.author_not && author === stripAt(cond.author_not)) return false;

  if (cond.assignee_is && !assignees.includes(stripAt(cond.assignee_is))) return false;
  if (
    cond.assignee_is_any &&
    !toArray(cond.assignee_is_any).some((assignee) => assignees.includes(stripAt(assignee)))
  ) return false;

  if (cond.reviewer_missing === true && requestedReviewers.length > 0) return false;
  if (cond.reviewer_present === true && requestedReviewers.length === 0) return false;

  if (cond.reviewer_is && !requestedReviewers.includes(stripAt(cond.reviewer_is))) return false;
  if (
    cond.reviewer_is_any &&
    !toArray(cond.reviewer_is_any).some((reviewer) => requestedReviewers.includes(stripAt(reviewer)))
  ) return false;

  if (cond.draft !== undefined && Boolean(item?.draft) !== Boolean(cond.draft)) return false;

  if (
    cond.draft_or_wip !== undefined &&
    Boolean(cond.draft_or_wip) !== (
      Boolean(item?.draft) ||
      /\bWIP\b/i.test(title)
    )
  ) return false;

  if (cond.days_inactive_gt !== undefined && !(runtime.ageDays > Number(cond.days_inactive_gt))) return false;
  if (cond.created_days_gt !== undefined && !(createdDays > Number(cond.created_days_gt))) return false;
  if (cond.created_days_lt !== undefined && !(createdDays < Number(cond.created_days_lt))) return false;

  if (cond.comment_count_eq !== undefined && commentCount !== Number(cond.comment_count_eq)) return false;
  if (cond.comment_count_gt !== undefined && !(commentCount > Number(cond.comment_count_gt))) return false;
  if (cond.comment_count_lt !== undefined && !(commentCount < Number(cond.comment_count_lt))) return false;

  if (cond.branch_name_matches && !compileRegex(cond.branch_name_matches).test(branchName)) return false;

  if (cond.base_branch_is && baseBranch !== cond.base_branch_is) return false;
  if (
    cond.base_branch_is_any &&
    !toArray(cond.base_branch_is_any).includes(baseBranch)
  ) return false;

  if (cond.changed_files_any && !matchAnyPattern(runtime.changedFiles, cond.changed_files_any)) return false;
  if (
    cond.changed_files_all &&
    !cond.changed_files_all.every((pattern) =>
      runtime.changedFiles.some((file) => minimatch(file, pattern, { dot: true }))
    )
  ) return false;
  if (cond.changed_files_none && matchAnyPattern(runtime.changedFiles, cond.changed_files_none)) return false;

  if (cond.changed_files_count_gt !== undefined && !(runtime.changedFiles.length > Number(cond.changed_files_count_gt))) return false;
  if (cond.changed_files_count_lt !== undefined && !(runtime.changedFiles.length < Number(cond.changed_files_count_lt))) return false;
  if (cond.changed_files_count_eq !== undefined && runtime.changedFiles.length !== Number(cond.changed_files_count_eq)) return false;

  if (cond.codeowners_match === true && runtime.codeownersOwners.length === 0) return false;

  return true;
}

async function applyLabels(action, runtime, itemNumber, currentLabels) {
  const owner = runtime.ctx.repo.owner;
  const repo = runtime.ctx.repo.repo;
  let targetLabels = [...currentLabels];

  if (action.add_labels) {
    targetLabels.push(...toArray(action.add_labels));
  }
  if (action.remove_labels) {
    const remove = new Set(toArray(action.remove_labels));
    targetLabels = targetLabels.filter((label) => !remove.has(label));
  }
  if (action.set_labels) {
    const removeMatching = toArray(action.set_labels.remove_matching);
    const add = toArray(action.set_labels.add);
    if (removeMatching.length > 0) {
      targetLabels = targetLabels.filter((label) => !matchLabelPatterns([label], removeMatching).length);
    }
    targetLabels.push(...add);
  }

  targetLabels = uniq(targetLabels);

  const changed = JSON.stringify(targetLabels.sort()) !== JSON.stringify(uniq(currentLabels).sort());
  if (!changed) return false;

  if (runtime.dryRun) {
    runtime.logs.push(`[dry-run] Would set labels on #${itemNumber}: ${targetLabels.join(', ')}`);
    return true;
  }

  await runtime.octokit.rest.issues.setLabels({
    owner,
    repo,
    issue_number: itemNumber,
    labels: targetLabels,
  });
  runtime.logs.push(`Labels set on #${itemNumber}: ${targetLabels.join(', ')}`);
  return true;
}

async function applyAssignees(action, runtime, itemNumber, item) {
  if (!action.assign) return false;
  const assignees = resolveTargets(action.assign, runtime, 'assignees');
  if (assignees.length === 0) return false;
  const current = (item.assignees || []).map((a) => a.login);
  const next = uniq([...current, ...assignees]);
  const changed = JSON.stringify(current.sort()) !== JSON.stringify(next.sort());
  if (!changed) return false;
  if (runtime.dryRun) {
    runtime.logs.push(`[dry-run] Would add assignees on #${itemNumber}: ${assignees.join(', ')}`);
    item.assignees = next.map((login) => ({ login }));
    return true;
  }
  await runtime.octokit.rest.issues.addAssignees({
    owner: runtime.ctx.repo.owner,
    repo: runtime.ctx.repo.repo,
    issue_number: itemNumber,
    assignees,
  });
  runtime.logs.push(`Added assignees on #${itemNumber}: ${assignees.join(', ')}`);
  item.assignees = next.map((login) => ({ login }));
  return true;
}

async function applyReviewers(action, runtime, pullNumber) {
  let reviewers = [];
  let teamReviewers = [];

  if (action.request_reviewers) {
    const requested = toArray(action.request_reviewers);
    for (const token of requested) {
      if (String(token).startsWith('@')) {
        const aliasName = String(token).slice(1);
        const override = runtime.config.aliases?.[aliasName];
        if (override?.type === 'team') {
          teamReviewers.push(override.team.split('/').pop());
        } else {
          reviewers.push(...resolveTargets([token], runtime, 'reviewers'));
        }
      } else {
        reviewers.push(stripAt(token));
      }
    }
  }

  if (action.sync_reviewers_from_codeowners) {
    for (const owner of runtime.codeownersOwners) {
      if (owner.includes('/')) teamReviewers.push(owner.split('/').pop());
      else reviewers.push(owner);
    }
  }

  reviewers = uniq(reviewers).filter((r) => r !== runtime.ctx.item?.user?.login);
  teamReviewers = uniq(teamReviewers);

  const currentUserReviewers = runtime.prState.requestedReviewers.map((u) => u.login);
  const currentTeamReviewers = runtime.prState.requestedTeams.map((t) => t.slug);
  const missingUsers = reviewers.filter((r) => !currentUserReviewers.includes(r));
  const missingTeams = teamReviewers.filter((t) => !currentTeamReviewers.includes(t));

  if (missingUsers.length === 0 && missingTeams.length === 0) return false;
  if (runtime.dryRun) {
    runtime.logs.push(`[dry-run] Would request reviewers on PR #${pullNumber}: users=${missingUsers.join(', ')} teams=${missingTeams.join(', ')}`);
    runtime.prState.requestedReviewers.push(...missingUsers.map((login) => ({ login })));
    runtime.prState.requestedTeams.push(...missingTeams.map((slug) => ({ slug, org: runtime.ctx.repo.owner })));
    return true;
  }

  await runtime.octokit.rest.pulls.requestReviewers({
    owner: runtime.ctx.repo.owner,
    repo: runtime.ctx.repo.repo,
    pull_number: pullNumber,
    reviewers: missingUsers,
    team_reviewers: missingTeams,
  });
  runtime.logs.push(`Requested reviewers on PR #${pullNumber}: users=${missingUsers.join(', ')} teams=${missingTeams.join(', ')}`);
  runtime.prState.requestedReviewers.push(...missingUsers.map((login) => ({ login })));
  runtime.prState.requestedTeams.push(...missingTeams.map((slug) => ({ slug, org: runtime.ctx.repo.owner })));
  return true;
}

async function applyComment(action, runtime, itemNumber) {
  if (!action.comment) return false;
  const prefix = runtime.config.defaults?.comment_marker_prefix || DEFAULT_COMMENT_MARKER_PREFIX;
  let marker = '';
  if (action.comment_once_key) {
    marker = buildMarker(prefix, action.comment_once_key);
    if (hasCommentMarker(runtime.comments, marker)) {
      runtime.logs.push(`Comment marker already exists for key '${action.comment_once_key}', skipping comment.`);
      return false;
    }
  }

  const body = [marker, renderTemplate(action.comment, buildRenderContext(runtime))].filter(Boolean).join('\n').trim();
  if (!body) return false;

  if (runtime.dryRun) {
    runtime.logs.push(`[dry-run] Would comment on #${itemNumber}: ${body}`);
    return true;
  }

  await runtime.octokit.rest.issues.createComment({
    owner: runtime.ctx.repo.owner,
    repo: runtime.ctx.repo.repo,
    issue_number: itemNumber,
    body,
  });
  runtime.logs.push(`Comment added on #${itemNumber}.`);
  return true;
}

async function executeActions(action, runtime) {
  const item = runtime.ctx.item;
  if (!item) return false;

  const itemNumber = item.number;
  let changed = false;

  changed = (await applyLabels(action, runtime, itemNumber, getLabels(item))) || changed;
  changed = (await applyAssignees(action, runtime, itemNumber, item)) || changed;
  if (runtime.ctx.itemType === 'pull_request') {
    changed = (await applyReviewers(action, runtime, itemNumber)) || changed;
  }
  changed = (await applyComment(action, runtime, itemNumber)) || changed;
  return changed;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Invalid config file.');
  if (config.version !== 1) throw new Error('Only config version 1 is supported.');
  if (!Array.isArray(config.rules)) throw new Error('rules must be an array.');
}

async function buildRuntime(config, ctx, octokit) {
  const item = getTrackedItem(ctx);
  const itemType = getItemType(ctx);
  const changedFiles = itemType === 'pull_request' && item
    ? await listPullRequestFiles(octokit, ctx.repo, item.number)
    : [];
  const comments = item
    ? await listIssueComments(octokit, ctx.repo, item.number)
    : [];
  const prState = itemType === 'pull_request' && item
    ? await getRequestedReviewers(octokit, ctx.repo, item.number)
    : { requestedReviewers: [], requestedTeams: [] };
  const codeownersPath = config.codeowners?.path ? path.resolve(config.codeowners.path) : path.resolve('.github/CODEOWNERS');
  const codeownersEntries = config.codeowners?.enabled === false ? [] : parseCodeownersFile(codeownersPath);
  const codeownersOwners = itemType === 'pull_request' ? matchCodeowners(codeownersEntries, changedFiles) : [];
  const updatedAt = item?.updated_at ? new Date(item.updated_at) : new Date();
  const ageDays = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

  return {
    config,
    ctx: {
      eventName: ctx.eventName,
      payload: ctx.payload,
      actor: ctx.actor,
      repo: ctx.repo,
      item,
      itemType,
    },
    octokit,
    changedFiles,
    comments,
    prState: {
      requestedReviewers: prState.users || prState.requestedReviewers || [],
      requestedTeams: prState.teams || prState.requestedTeams || [],
    },
    codeownersOwners,
    ageDays,
    dryRun: false,
    logs: [],
  };
}

async function runInteractiveSchedule(runtime) {
  const items = [];

  const issues = await runtime.octokit.paginate(runtime.octokit.rest.issues.listForRepo, {
    owner: runtime.ctx.repo.owner,
    repo: runtime.ctx.repo.repo,
    state: 'open',
    per_page: 100,
  });

  for (const item of issues) {
    const itemType = item.pull_request ? 'pull_request' : 'issue';
    const updatedAt = new Date(item.updated_at);
    const ageDays = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));
    items.push({ item, itemType, ageDays });
  }

  runtime.logs.push(`Scan mode: found ${items.length} open items.`);

  for (const candidate of items) {
    runtime.logs.push(`Scanning #${candidate.item.number} (${candidate.itemType}), ageDays=${candidate.ageDays}`);

    const candidateCtx = {
      eventName: runtime.ctx.eventName,
      payload: runtime.ctx.payload,
      actor: runtime.ctx.actor,
      repo: runtime.ctx.repo,
      item: candidate.item,
      itemType: candidate.itemType,
    };

    const changedFiles = candidate.itemType === 'pull_request'
      ? await listPullRequestFiles(runtime.octokit, runtime.ctx.repo, candidate.item.number)
      : [];

    const comments = await listIssueComments(runtime.octokit, runtime.ctx.repo, candidate.item.number);

    const prState = candidate.itemType === 'pull_request'
      ? await getRequestedReviewers(runtime.octokit, runtime.ctx.repo, candidate.item.number)
      : { users: [], teams: [] };

    const codeownersEntries = runtime.config.codeowners?.enabled === false
      ? []
      : parseCodeownersFile(path.resolve(runtime.config.codeowners?.path || '.github/CODEOWNERS'));

    const codeownersOwners = candidate.itemType === 'pull_request'
      ? matchCodeowners(codeownersEntries, changedFiles)
      : [];

    const candidateRuntime = {
      ...runtime,
      ctx: candidateCtx,
      changedFiles,
      comments,
      prState: {
        requestedReviewers: prState.users || [],
        requestedTeams: prState.teams || [],
      },
      codeownersOwners,
      ageDays: candidate.ageDays,
      logs: runtime.logs,
    };

    let matched = false;
    for (const rule of runtime.config.rules) {
      if (rule.enabled === false) continue;
      if (!toArray(rule.on).includes('schedule.daily')) continue;
      if (!evaluateConditionObject(rule.if, candidateRuntime)) continue;

      matched = true;
      const changed = await executeActions(rule.then || {}, candidateRuntime);
      runtime.logs.push(`Schedule rule '${rule.name}' matched #${candidate.item.number} (${candidate.itemType}), changed=${changed}`);
    }

    if (!matched) {
      const fallbackAction = runtime.config.fallback?.[candidate.itemType];
      if (fallbackAction) {
        const changed = await executeActions(fallbackAction, candidateRuntime);
        runtime.logs.push(`Fallback applied to #${candidate.item.number} (${candidate.itemType}), changed=${changed}`);
      }
    }
  }
}

async function run() {
  const configPathInput = core.getInput('config-path') || '.github/triage-rules.yml';
  const configPath = path.resolve(configPathInput);

  if (!fileExists(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const config = readYaml(configPath);
  validateConfig(config);

  if (process.argv.includes('--validate-config')) {
    console.log(`Config OK: ${configPath}`);
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Missing GITHUB_TOKEN.');

  const octokit = getOctokit(token);
  const runtime = await buildRuntime(config, context, octokit);
  const eventKey = getEventName(context);

  runtime.dryRun =
    Boolean(config.defaults?.dry_run) ||
    isTruthyString(core.getInput('dry-run')) ||
    isTruthyString(process.env.INPUT_DRY_RUN);

  if (
    context.eventName === 'schedule' ||
    (context.eventName === 'workflow_dispatch' && runtime.ctx.item === null)
  ) {
    await runInteractiveSchedule(runtime);
  } else {
    let matched = false;
    for (const rule of config.rules) {
      if (rule.enabled === false) continue;
      if (!toArray(rule.on).includes(eventKey)) continue;
      if (!evaluateConditionObject(rule.if, runtime)) continue;
      matched = true;
      const changed = await executeActions(rule.then || {}, runtime);
      runtime.logs.push(`Rule '${rule.name}' matched, changed=${changed}`);
      if (rule.stop === true) break;
    }

    if (!matched && runtime.ctx.item) {
      const fallbackAction = config.fallback?.[runtime.ctx.itemType];
      if (fallbackAction) {
        const changed = await executeActions(fallbackAction, runtime);
        runtime.logs.push(`Fallback applied (${runtime.ctx.itemType}), changed=${changed}`);
      } else {
        runtime.logs.push('No rule matched and no fallback configured.');
      }
    }
  }

  for (const line of runtime.logs) console.log(line);
}

run().catch((error) => {
  core.setFailed(error.stack || error.message);
});
