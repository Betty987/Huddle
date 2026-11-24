import type { CollectionSchema } from 'deepspace/schema'

/**
 * SquadMembers — per-squad role for a user.
 *
 * One record per (userId, squadId) pair.  `userId` is set explicitly by
 * actions to the authenticated caller's ID, making it a stable query key.
 *
 * Role values: 'owner' | 'member' | 'viewer'
 *   - owner:  created the squad; can delete the squad and remove members
 *   - member: can add jobs, move cards, comment
 *   - viewer: read-only (enforced in server actions, not just the UI)
 *
 * read: true lets any authenticated user load membership records so the squad
 * page can resolve every member's display name and role.  Writes are locked to
 * actions only — no direct client mutations allowed.
 */
export const squadMembersSchema: CollectionSchema = {
  name: 'squadMembers',
  columns: [
    { name: 'squadId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'userId',  storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'role',    storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false, delete: false },
    // read: false — no direct reads; use the listMembers server action which
    // checks squad membership before returning any data.
    member: { read: false, create: false, update: false, delete: false },
    admin:  { read: true,  create: true,  update: true,  delete: true  },
  },
}
