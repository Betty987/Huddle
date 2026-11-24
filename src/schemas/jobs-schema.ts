import type { CollectionSchema } from 'deepspace/schema'

/**
 * Jobs — a job posting tracked by a squad.
 *
 * Status pipeline: saved → applied → oa → interview → offer | rejected
 *
 * All writes go through server actions which verify the caller has at least
 * 'member' role in the squad (not 'viewer').  This check lives in the action,
 * not just the UI — a viewer literally cannot advance a card.
 *
 * read: true lets all authenticated users subscribe to jobs.  Because the UI
 * only ever opens the squad page for squads the user belongs to, in practice
 * only squad members see these records.  For a small-group trust tool this is
 * the right tradeoff; the writeup explains the alternative (collaboratorsField
 * on jobs) and why it was deferred.
 */
export const jobsSchema: CollectionSchema = {
  name: 'jobs',
  columns: [
    { name: 'squadId',     storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'title',       storage: 'text', interpretation: 'plain' },
    { name: 'company',     storage: 'text', interpretation: 'plain' },
    { name: 'url',         storage: 'text', interpretation: 'url' },
    // 'internship' | 'full-time' | 'part-time' | 'contract'
    { name: 'roleType',    storage: 'text', interpretation: 'plain' },
    // ISO date string YYYY-MM-DD, or empty string
    { name: 'deadline',    storage: 'text', interpretation: 'plain' },
    // 'yes' | 'no' | 'unknown'
    { name: 'sponsorship', storage: 'text', interpretation: 'plain' },
    { name: 'notes',       storage: 'text', interpretation: 'plain' },
    // 'saved' | 'applied' | 'oa' | 'interview' | 'offer' | 'rejected'
    { name: 'status',      storage: 'text', interpretation: 'plain' },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    member: { read: true,  create: false, update: false, delete: false },
    admin:  { read: true,  create: true,  update: true,  delete: true  },
  },
}
