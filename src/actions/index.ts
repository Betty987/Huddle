/**
 * Server actions — privileged, server-side functions that run with RBAC bypassed.
 *
 * TRUST MODEL: every action receives the verified caller's userId.  RBAC is OFF
 * inside action tools, so we must enforce squad-level roles ourselves before
 * any write.  The pattern is always:
 *   1. Load the caller's squadMembers record.
 *   2. Check the role against the required minimum.
 *   3. Only then perform the mutation.
 *
 * A viewer calling updateJobStatus gets { success: false, error: 'Forbidden' }
 * from this file — not from a UI gate, not from the schema.
 */

import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'

type SquadRole = 'owner' | 'member' | 'viewer'

/** Minimum role required: 'member' means owner OR member (not viewer). */
function roleAtLeast(actual: SquadRole, minimum: SquadRole): boolean {
  const order: SquadRole[] = ['viewer', 'member', 'owner']
  return order.indexOf(actual) >= order.indexOf(minimum)
}

/** Look up the caller's membership record for a squad. Returns null if not a member. */
async function getMembership(
  tools: Parameters<ActionHandler<Env>>[0]['tools'],
  userId: string,
  squadId: string,
): Promise<{ role: SquadRole; recordId: string } | null> {
  const result = await tools.query('squadMembers', {
    where: { squadId, userId },
    limit: 1,
  })
  if (!result.success || !result.data?.records?.length) return null
  const rec = result.data.records[0] as unknown as Record<string, unknown>
  return {
    role: rec['role'] as SquadRole,
    recordId: rec['recordId'] as string,
  }
}

/** Mint a short random invite code (6 uppercase alphanumeric chars). */
function mintInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  for (const b of bytes) code += chars[b % chars.length]
  return code
}

export const actions: Record<string, ActionHandler<Env>> = {
  /**
   * createSquad — create a new squad and register the caller as owner.
   *
   * Input:  { name: string }
   * Output: { squadId: string, inviteCode: string }
   */
  async createSquad({ userId, params, tools }) {
    const name = (params.name as string | undefined)?.trim()
    if (!name) return { success: false, error: 'Name is required' }

    const inviteCode = mintInviteCode()
    const memberIds = JSON.stringify([userId])

    const squadResult = await tools.create('squads', { name, inviteCode, memberIds })
    if (!squadResult.success) return { success: false, error: 'Failed to create squad' }

    const squadId = squadResult.data?.recordId
    if (!squadId) return { success: false, error: 'No squad ID returned' }

    const memberResult = await tools.create('squadMembers', { squadId, userId, role: 'owner' })
    if (!memberResult.success) {
      // Best-effort cleanup: delete the squad we just created
      await tools.remove('squads', squadId)
      return { success: false, error: 'Failed to record membership' }
    }

    return { success: true, data: { squadId, inviteCode } }
  },

  /**
   * joinSquad — join an existing squad by invite code.
   *
   * Input:  { inviteCode: string }
   * Output: { squadId: string, name: string }
   */
  async joinSquad({ userId, params, tools }) {
    const inviteCode = (params.inviteCode as string | undefined)?.trim().toUpperCase()
    if (!inviteCode) return { success: false, error: 'Invite code is required' }

    // RBAC is bypassed in actions, so this query finds the squad regardless of
    // whether the caller is in memberIds yet.
    const squadsResult = await tools.query('squads', {
      where: { inviteCode },
      limit: 1,
    })
    if (!squadsResult.success || !squadsResult.data?.records?.length) {
      return { success: false, error: 'Invalid invite code' }
    }

    const squad = squadsResult.data.records[0] as unknown as Record<string, unknown>
    const squadId = squad['recordId'] as string

    // Check if already a member
    const existing = await getMembership(tools, userId, squadId)
    if (existing) return { success: false, error: 'You are already in this squad' }

    // Add to memberIds array
    let memberIds: string[] = []
    try {
      memberIds = JSON.parse(squad['memberIds'] as string) as string[]
    } catch {
      memberIds = []
    }
    if (!memberIds.includes(userId)) memberIds.push(userId)

    // Write 1: add userId to the squad's collaboratorsField array.
    const updateResult = await tools.update('squads', squadId, {
      memberIds: JSON.stringify(memberIds),
    })
    if (!updateResult.success) return { success: false, error: 'Failed to join squad' }

    // Write 2: create the role record.  If this fails, roll back write 1 so the
    // two copies never drift — the user ends up with no access rather than partial.
    const memberResult = await tools.create('squadMembers', { squadId, userId, role: 'member' })
    if (!memberResult.success) {
      const rollback = memberIds.filter((id) => id !== userId)
      await tools.update('squads', squadId, { memberIds: JSON.stringify(rollback) })
      return { success: false, error: 'Failed to record membership; rolled back' }
    }

    return { success: true, data: { squadId, name: squad['name'] } }
  },

  /**
   * addJob — add a job card to a squad board.
   *
   * Requires at least 'member' role (viewers cannot add jobs).
   *
   * Input:  { squadId, title, company, url?, roleType?, deadline?, sponsorship?, notes? }
   * Output: { jobId: string }
   */
  async addJob({ userId, params, tools }) {
    const { squadId, title, company, url, roleType, deadline, sponsorship, notes } = params as {
      squadId: string
      title: string
      company: string
      url?: string
      roleType?: string
      deadline?: string
      sponsorship?: string
      notes?: string
    }

    if (!squadId) return { success: false, error: 'squadId is required' }
    if (!title?.trim()) return { success: false, error: 'title is required' }
    if (!company?.trim()) return { success: false, error: 'company is required' }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'You are not a member of this squad' }
    if (!roleAtLeast(membership.role, 'member')) {
      return { success: false, error: 'Viewers cannot add jobs' }
    }

    const jobResult = await tools.create('jobs', {
      squadId,
      title: title.trim(),
      company: company.trim(),
      url: url?.trim() ?? '',
      roleType: roleType ?? 'full-time',
      deadline: deadline ?? '',
      sponsorship: sponsorship ?? 'unknown',
      notes: notes?.trim() ?? '',
      status: 'saved',
    })

    if (!jobResult.success) return { success: false, error: 'Failed to create job' }
    return { success: true, data: { jobId: jobResult.data?.recordId } }
  },

  /**
   * updateJobStatus — move a job card to a new status column.
   *
   * Requires at least 'member' role.
   *
   * Input:  { jobId, squadId, status }
   * Output: {}
   */
  async updateJobStatus({ userId, params, tools }) {
    const { jobId, squadId, status } = params as {
      jobId: string
      squadId: string
      status: string
    }

    const validStatuses = ['saved', 'applied', 'oa', 'interview', 'offer', 'rejected']
    if (!validStatuses.includes(status)) {
      return { success: false, error: 'Invalid status' }
    }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'You are not a member of this squad' }
    if (!roleAtLeast(membership.role, 'member')) {
      return { success: false, error: 'Viewers cannot move cards' }
    }

    // Verify the job belongs to this squad (prevents moving another squad's job)
    const jobResult = await tools.get('jobs', jobId)
    const jobData = jobResult.data as unknown as Record<string, unknown> | undefined
    if (!jobResult.success || jobData?.['squadId'] !== squadId) {
      return { success: false, error: 'Job not found in this squad' }
    }

    await tools.update('jobs', jobId, { status })
    return { success: true, data: {} }
  },

  /**
   * deleteJob — remove a job card and its comments.
   *
   * Requires at least 'member' role.
   *
   * Input:  { jobId, squadId }
   * Output: {}
   */
  async deleteJob({ userId, params, tools }) {
    const { jobId, squadId } = params as { jobId: string; squadId: string }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'You are not a member of this squad' }
    if (!roleAtLeast(membership.role, 'member')) {
      return { success: false, error: 'Viewers cannot delete jobs' }
    }

    const jobResult2 = await tools.get('jobs', jobId)
    const jobData2 = jobResult2.data as unknown as Record<string, unknown> | undefined
    if (!jobResult2.success || jobData2?.['squadId'] !== squadId) {
      return { success: false, error: 'Job not found in this squad' }
    }

    // Cascade-delete comments first (up to 500; re-loop if larger)
    let deleted = 100
    while (deleted >= 100) {
      const r = await tools.deleteWhere('comments', { jobId }, 100)
      deleted = r.success ? (r.data?.deleted ?? 0) : 0
    }

    await tools.remove('jobs', jobId)
    return { success: true, data: {} }
  },

  /**
   * leaveSquad — remove yourself from a squad.
   *
   * Owners cannot leave — they must delete the squad or transfer ownership first.
   *
   * Input:  { squadId }
   * Output: {}
   */
  async leaveSquad({ userId, params, tools }) {
    const { squadId } = params as { squadId: string }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'You are not in this squad' }
    if (membership.role === 'owner') {
      return { success: false, error: 'Owners cannot leave — delete the squad instead' }
    }

    // Remove from memberIds — capture original for rollback.
    const squadResult = await tools.get('squads', squadId)
    if (!squadResult.success || !squadResult.data) {
      return { success: false, error: 'Could not load squad' }
    }
    const sd = squadResult.data as unknown as Record<string, unknown>
    let memberIds: string[] = []
    try { memberIds = JSON.parse(sd['memberIds'] as string) } catch { memberIds = [] }
    const originalMemberIds = [...memberIds]
    memberIds = memberIds.filter((id) => id !== userId)

    // Write 1: shrink the collaboratorsField array.
    const updateResult = await tools.update('squads', squadId, {
      memberIds: JSON.stringify(memberIds),
    })
    if (!updateResult.success) return { success: false, error: 'Failed to update squad' }

    // Write 2: delete the role record.  Roll back write 1 on failure.
    const removeResult = await tools.remove('squadMembers', membership.recordId)
    if (!removeResult.success) {
      await tools.update('squads', squadId, { memberIds: JSON.stringify(originalMemberIds) })
      return { success: false, error: 'Failed to remove membership record; rolled back' }
    }

    return { success: true, data: {} }
  },

  /**
   * listMembers — return all members of a squad and the caller's own role.
   *
   * Checks that the caller is a member before returning anything.
   * The result is a point-in-time snapshot; the client caches it in state.
   *
   * Input:  { squadId }
   * Output: { members: Array<{ recordId, userId, role }>, myRole }
   */
  async listMembers({ userId, params, tools }) {
    const { squadId } = params as { squadId: string }
    if (!squadId) return { success: false, error: 'squadId is required' }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'Not a member of this squad' }

    const result = await tools.query('squadMembers', { where: { squadId }, limit: 200 })
    if (!result.success) return { success: false, error: 'Could not load members' }

    const members = (result.data?.records ?? []).map((r) => {
      const rec = r as unknown as Record<string, unknown>
      return {
        recordId: rec['recordId'] as string,
        userId:   rec['userId']   as string,
        role:     rec['role']     as string,
      }
    })

    return { success: true, data: { members, myRole: membership.role } }
  },

  /**
   * addComment — add a comment to a job card.
   *
   * Requires at least 'member' squad role (viewers cannot comment).
   * Also verifies the job belongs to the given squad.
   *
   * Input:  { jobId, squadId, body }
   * Output: { commentId }
   */
  async addComment({ userId, params, tools }) {
    const { jobId, squadId, body } = params as {
      jobId: string
      squadId: string
      body: string
    }

    if (!body?.trim()) return { success: false, error: 'Comment body is required' }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'Not a member of this squad' }
    if (!roleAtLeast(membership.role, 'member')) {
      return { success: false, error: 'Viewers cannot comment' }
    }

    // Verify the job belongs to this squad.
    const jobResult = await tools.get('jobs', jobId)
    const jobData = jobResult.data as unknown as Record<string, unknown> | undefined
    if (!jobResult.success || jobData?.['squadId'] !== squadId) {
      return { success: false, error: 'Job not found in this squad' }
    }

    const result = await tools.create('comments', { jobId, squadId, body: body.trim() })
    if (!result.success) return { success: false, error: 'Failed to post comment' }

    return { success: true, data: { commentId: result.data?.recordId } }
  },

  /**
   * changeRole — change a member's squad role (owner → member or viewer).
   *
   * Only the squad owner may call this.  Owners cannot demote themselves.
   * Valid target roles: 'member' | 'viewer'  (ownership is non-transferable).
   *
   * Input:  { squadId, targetUserId, role }
   * Output: {}
   */
  async changeRole({ userId, params, tools }) {
    const { squadId, targetUserId, role } = params as {
      squadId: string
      targetUserId: string
      role: string
    }

    if (!['member', 'viewer'].includes(role)) {
      return { success: false, error: 'Role must be "member" or "viewer"' }
    }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership || membership.role !== 'owner') {
      return { success: false, error: 'Only the squad owner can change roles' }
    }
    if (targetUserId === userId) {
      return { success: false, error: 'Owner cannot change their own role' }
    }

    const target = await getMembership(tools, targetUserId, squadId)
    if (!target) return { success: false, error: 'User is not in this squad' }
    if (target.role === 'owner') {
      return { success: false, error: "Cannot change another owner's role" }
    }

    await tools.update('squadMembers', target.recordId, { role })
    return { success: true, data: {} }
  },

  /**
   * deleteSquad — permanently delete a squad and all its data.
   *
   * Owner-only.  Cascades: comments → jobs → squadMembers → squad record.
   *
   * Input:  { squadId }
   * Output: {}
   */
  async deleteSquad({ userId, params, tools }) {
    const { squadId } = params as { squadId: string }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership || membership.role !== 'owner') {
      return { success: false, error: 'Only the squad owner can delete the squad' }
    }

    // Cascade-delete in dependency order
    for (const collection of ['comments', 'jobs', 'squadMembers'] as const) {
      let deleted = 100
      while (deleted >= 100) {
        const r = await tools.deleteWhere(collection, { squadId }, 100)
        deleted = r.success ? (r.data?.deleted ?? 0) : 0
      }
    }

    await tools.remove('squads', squadId)
    return { success: true, data: {} }
  },
}
