import type { CollectionSchema } from 'deepspace/schema'

/**
 * Comments — threaded messages on a job card.
 *
 * Uses fire-and-forget mutations (useMutations) for instant real-time UX.
 * The UI only renders the comment box inside a squad page the user is already
 * a member of, so we accept member: { create: true } here.
 *
 * update/delete: 'own' lets users edit or remove their own comments.
 */
export const commentsSchema: CollectionSchema = {
  name: 'comments',
  columns: [
    { name: 'jobId',   storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'squadId', storage: 'text', interpretation: 'plain', immutable: true, required: true },
    { name: 'body',    storage: 'text', interpretation: 'plain', required: true },
  ],
  permissions: {
    viewer: { read: false, create: false, update: false,  delete: false  },
    // create: false — all creates go through the addComment server action,
    // which checks squad membership and rejects viewers.
    // update/delete: 'own' stays as direct mutations — the user can only
    // touch their own comments and there is no squad-role concern there.
    member: { read: true,  create: false, update: 'own',  delete: 'own'  },
    admin:  { read: true,  create: true,  update: true,   delete: true   },
  },
}
