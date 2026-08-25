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

export const dashboardCatalogDomainSpec = defineDomain({
  name: 'dsh_dashboard',
  // Additive tables are initialized empty by storage-domain, so existing v0
  // Catalog media need no migration.
  version: 0,
  tables: {
    projects: domainTable<ProjectId, ProjectRecord>(projectRecordSchema),
    repositories: domainTable<RepositoryId, RepositoryRecord>(repositoryRecordSchema),
    discovery_roots: domainTable<DiscoveryRootId, DiscoveryRootRecord>(discoveryRootRecordSchema),
    settings: domainTable<CatalogSettingId, ActiveProjectRecord>(activeProjectRecordSchema),
    worker_sessions: domainTable<WorkerSessionKey, WorkerSessionRecord>(workerSessionRecordSchema),
  },
})
