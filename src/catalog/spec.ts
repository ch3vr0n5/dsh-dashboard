/** Harness storage-domain declaration for Project Catalog state. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type {
  ActiveProjectRecord,
  CatalogSettingId,
  DiscoveryRootId,
  DiscoveryRootRecord,
  ProjectId,
  ProjectRecord,
  RepositoryId,
  RepositoryRecord,
  WorkerSessionKey,
  WorkerSessionRecord,
  LifecycleSessionRecord,
} from './types.ts'

const id = z.uuid()
const nonBlank = z.string().trim().min(1)
const timestamp = z.string().refine(value => Number.isFinite(Date.parse(value)), 'expected an ISO timestamp')

export const projectRecordSchema = z.object({
  id,
  name: nonBlank,
  root: nonBlank,
  policyPath: nonBlank.optional(),
  repositoryIds: z.array(id),
  workspaceStrategy: z.union([z.literal('worktree'), z.literal('controlled-directory')]),
  autonomousClaims: z.literal(false),
  source: z.union([z.literal('current-workspace'), z.literal('manual'), z.literal('discovery')]),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict() as z.ZodType<ProjectRecord>

export const repositoryRecordSchema = z.object({
  id,
  kind: z.literal('git'),
  root: nonBlank,
  remoteUrl: nonBlank.optional(),
  branch: nonBlank.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict() as z.ZodType<RepositoryRecord>

export const discoveryRootRecordSchema = z.object({
  id,
  path: nonBlank,
  maxDepth: z.number().int().min(1).max(8),
  confirmationRequired: z.literal(true),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict() as z.ZodType<DiscoveryRootRecord>

export const activeProjectRecordSchema = z.union([
  z.object({
    mode: z.literal('project').optional(),
    projectId: id,
    updatedAt: timestamp,
  }).strict(),
  z.object({
    mode: z.literal('global'),
    updatedAt: timestamp,
  }).strict(),
]) as z.ZodType<ActiveProjectRecord>

export const workerSessionRecordSchema = z.object({
  // The unregistered current workspace uses the stable synthetic
  // "current-workspace" id; registered Catalog projects use UUIDs.
  projectId: nonBlank,
  issueKey: nonBlank,
  sessionId: nonBlank.optional(),
  status: z.union([z.literal('running'), z.literal('held')]),
  failureCount: z.number().int().nonnegative().optional(),
  issueRevision: nonBlank,
  holdReason: nonBlank.optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict() as z.ZodType<WorkerSessionRecord>

export const lifecycleSessionRecordSchema = z.object({
  projectId: nonBlank,
  issueKey: nonBlank,
  role: z.enum(['planning', 'implementation', 'qa', 'review', 'escalation']),
  sessionId: nonBlank.optional(),
  status: z.union([z.literal('running'), z.literal('completed'), z.literal('failed')]),
  issueRevision: nonBlank,
  provider: nonBlank,
  model: nonBlank,
  reasoningEffort: nonBlank.optional(),
  permissionPreset: nonBlank,
  startedAt: timestamp,
  updatedAt: timestamp,
  finishedAt: timestamp.optional(),
  runtimeMs: z.number().int().nonnegative().optional(),
  tokens: z.object({
    input: z.number().int().nonnegative(), output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(), cacheWrite: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(), total: z.number().int().nonnegative(),
  }).strict(),
  handoff: nonBlank.optional(),
  error: nonBlank.optional(),
}).strict() as z.ZodType<LifecycleSessionRecord>

export const dashboardCatalogDomainSpec = defineDomain({
  name: 'dsh_dashboard',
  // Additive tables are initialized empty by storage-domain, so existing v0
  // Catalog media need no migration.
  // Additive table: v0 catalog media continue to open with an empty lifecycle
  // table, so no destructive or data-rewriting migration is required.
  version: 0,
  tables: {
    projects: domainTable<ProjectId, ProjectRecord>(projectRecordSchema),
    repositories: domainTable<RepositoryId, RepositoryRecord>(repositoryRecordSchema),
    discovery_roots: domainTable<DiscoveryRootId, DiscoveryRootRecord>(discoveryRootRecordSchema),
    settings: domainTable<CatalogSettingId, ActiveProjectRecord>(activeProjectRecordSchema),
    worker_sessions: domainTable<WorkerSessionKey, WorkerSessionRecord>(workerSessionRecordSchema),
    lifecycle_sessions: domainTable<string, LifecycleSessionRecord>(lifecycleSessionRecordSchema),
  },
})
