import type { CollectionSchema } from 'deepspace/schema'

/**
 * Squads — a named group sharing a job board.
 *
 * Visibility is driven by the `memberIds` JSON array (collaboratorsField).
 * The DO drops squad records from the WebSocket stream for any user whose ID
 * is not in that array, so the client never receives squads it has no access to.
 *
 * All writes go through server actions (createSquad / joinSquad) which own the
 * memberIds update and enforce ownership before any change.
 */
export const squadsSchema: CollectionSchema = {
  name: 'squads',
  columns: [
    { name: 'name', storage: 'text', interpretation: 'plain', required: true },
    // Short random code — users share this to invite others.
    { name: 'inviteCode', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    // JSON-encoded string[]: the user IDs of all squad members.
    // Kept as a denormalized snapshot so the collaboratorsField gate works
    // without a cross-collection join inside the DO.
    { name: 'memberIds', storage: 'text', interpretation: 'json' },
  ],
  collaboratorsField: 'memberIds',
  permissions: {
    viewer: { read: 'shared', create: false, update: false, delete: false },
    member: { read: 'shared', create: false, update: false, delete: false },
    admin:  { read: true,     create: true,  update: true,  delete: true  },
  },
}
