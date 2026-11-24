/**
 * Collection Schemas
 *
 * All collections with columns and RBAC permissions.
 * Single source of truth — imported by both worker and frontend.
 *
 * Add schemas by creating a file in src/schemas/ and importing it here.
 */

import type { CollectionSchema } from 'deepspace/schema'
import { usersSchema } from './schemas/users-schema'
import { settingsSchema } from './schemas/admin-schema'
import { squadsSchema } from './schemas/squads-schema'
import { squadMembersSchema } from './schemas/squad-members-schema'
import { jobsSchema } from './schemas/jobs-schema'
import { applicationsSchema } from './schemas/applications-schema'
import { commentsSchema } from './schemas/comments-schema'

export const schemas: CollectionSchema[] = [
  usersSchema,
  settingsSchema,
  squadsSchema,
  squadMembersSchema,
  jobsSchema,
  applicationsSchema,
  commentsSchema,
]
