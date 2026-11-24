import type { CollectionSchema } from 'deepspace/schema'

/**
 * Applications — one record per (job, member) pair.
 *
 * Each squad member tracks their own progress through the pipeline.
 * status: 'saved' | 'applied' | 'oa' | 'interview' | 'offer' | 'rejected'
 *
 * squadId is stored (denormalised from jobs) so deleteSquad can wipe all
 * applications in one deleteWhere call without scanning every job.
 *
 * All writes go through the setMyStatus server action, which verifies
 * the caller is owner/member of the squad and only writes their own record.
 */
export const applicationsSchema: CollectionSchema = {
  name: 'applications',
  columns: [
    { name: 'squadId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'jobId',   storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'userId',  storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'status',  storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    // Reads: all squad members may read all applications (filtered by squadId on the client).
    // Writes: blocked here — setMyStatus action enforces userId === caller.
    member: { read: true,  create: false, update: false, delete: false },
    admin:  { read: true,  create: true,  update: true,  delete: true  },
  },
}
