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
import { sendDeadlineReminders } from '../cron.js'

type SquadRole = 'owner' | 'member' | 'viewer'

/** Minimum role required: 'member' means owner OR member (not viewer). */
function roleAtLeast(actual: SquadRole, minimum: SquadRole): boolean {
  const order: SquadRole[] = ['viewer', 'member', 'owner']
  return order.indexOf(actual) >= order.indexOf(minimum)
}

/**
 * Extract the custom-field bag from a single tools.query record.
 *
 * tools.query returns Array<{ recordId, data: T, createdBy, createdAt, updatedAt }>.
 * Custom fields live under .data — not at the top level of the record.
 */
function qData(r: unknown): Record<string, unknown> {
  return ((r as { data?: Record<string, unknown> })?.data) ?? {}
}

/**
 * Extract the custom-field bag from a tools.get result.
 *
 * tools.get returns { record: { recordId, data: T, createdBy, createdAt, updatedAt } }.
 * result.data is the GetActionData wrapper, so the field bag is at result.data.record.data.
 */
function gData(result: { data?: unknown }): Record<string, unknown> {
  return (
    (result.data as { record?: { data?: Record<string, unknown> } } | undefined)
      ?.record?.data ?? {}
  )
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
  const data = qData(rec)
  const role = data['role'] as SquadRole | undefined
  if (!role) return null   // malformed record — treat as non-member
  return {
    role,
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

// ── AI extraction ─────────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM =
  'You are a job posting parser. Extract structured information and return ONLY valid JSON — no markdown fences, no explanation, no extra keys.'

function extractionPrompt(text: string): string {
  // Truncate so we don't blast a 50-page site through the LLM
  const truncated = text.slice(0, 8_000)
  return `Extract the following fields from this job posting and return a single JSON object.

Fields:
- title: string        — job title (required)
- company: string      — company name (required)
- location: string|null — office location, "Remote", or "Hybrid" (null if not found)
- deadline: string|null — application deadline as YYYY-MM-DD (null if not found or unclear)
- sponsorship: "yes"|"no"|"unknown" — visa/work-authorization sponsorship
- requirements: string[] — up to 5 key requirements or qualifications, brief phrases

Return JSON only. Example:
{"title":"Software Engineer","company":"Acme","location":"San Francisco, CA","deadline":"2026-12-31","sponsorship":"no","requirements":["5+ years Python","Kubernetes","CI/CD pipelines"]}

Job posting:
<posting>
${truncated}
</posting>`
}

type ExtractedJob = {
  title?: string
  company?: string
  location?: string | null
  deadline?: string | null
  sponsorship?: 'yes' | 'no' | 'unknown'
  requirements?: string[]
}

type ActionOk   = { success: true;  data: Record<string, unknown> }
type ActionFail = { success: false; error: string; details?: Record<string, unknown> }

/** Shared extraction + job-create logic used by importJob and importJobFromText. */
async function extractAndCreateJob(
  tools: Parameters<ActionHandler<Env>>[0]['tools'],
  { squadId, text, url }: { squadId: string; text: string; url?: string },
): Promise<ActionOk | ActionFail> {
  // ── 2. Extract with Claude ─────────────────────────────────────────────
  const aiResult = await tools.integration('anthropic/chat-completion', {
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    temperature: 0,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: extractionPrompt(text) }],
  })

  if (!aiResult.success) {
    return { success: false as const, error: 'AI extraction failed. Try adding the job manually.' }
  }

  const aiData = aiResult.data as { content?: Array<{ type: string; text: string }> }
  const rawText = aiData?.content?.find((b) => b.type === 'text')?.text ?? ''

  let extracted: ExtractedJob
  try {
    // Claude might still wrap in a code fence despite instructions — strip it
    const cleaned = rawText.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('No JSON object found')
    extracted = JSON.parse(jsonMatch[0]) as ExtractedJob
  } catch {
    return { success: false as const, error: 'Could not parse AI response. Try adding the job manually.' }
  }

  if (!extracted.title?.trim() || !extracted.company?.trim()) {
    return { success: false as const, error: 'Could not identify job title or company. Try adding the job manually.' }
  }

  // Build notes from location and requirements
  const notesParts: string[] = []
  if (extracted.location) notesParts.push(`Location: ${extracted.location}`)
  if (extracted.requirements?.length) {
    notesParts.push(`Requirements:\n${extracted.requirements.slice(0, 5).map((r) => `• ${r}`).join('\n')}`)
  }

  // Validate sponsorship value
  const validSponsorship = ['yes', 'no', 'unknown'] as const
  const sponsorship = validSponsorship.includes(extracted.sponsorship as 'yes' | 'no' | 'unknown')
    ? (extracted.sponsorship as 'yes' | 'no' | 'unknown')
    : 'unknown'

  // ── 3. Create the job record ───────────────────────────────────────────
  const jobResult = await tools.create('jobs', {
    squadId,
    title: extracted.title.trim(),
    company: extracted.company.trim(),
    url: url ?? '',
    roleType: 'full-time',
    deadline: extracted.deadline ?? '',
    sponsorship,
    notes: notesParts.join('\n\n'),
    status: 'saved',
  })

  if (!jobResult.success) return { success: false as const, error: 'Failed to save job' }
  return { success: true as const, data: { jobId: jobResult.data?.recordId } }
}

// ── Actions ───────────────────────────────────────────────────────────────────

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
    const squadFields = qData(squad)

    // Check if already a member
    const existing = await getMembership(tools, userId, squadId)
    if (existing) return { success: false, error: 'You are already in this squad' }

    // Add to memberIds array — the platform auto-parses interpretation:'json' fields,
    // so squadFields['memberIds'] may already be a string[] rather than a JSON string.
    const rawIds = squadFields['memberIds']
    let memberIds: string[] = Array.isArray(rawIds)
      ? (rawIds as string[])
      : (() => { try { return JSON.parse(rawIds as string) as string[] } catch { return [] } })()
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

    return { success: true, data: { squadId, name: squadFields['name'] as string } }
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
   * setMyStatus — set the caller's personal application status for a job.
   *
   * Creates or updates the caller's application record (upsert).
   * Only the caller's own record is ever touched — server enforces this.
   * Requires at least 'member' role; viewers cannot track applications.
   *
   * Input:  { jobId, squadId, status }
   * Output: {}
   */
  async setMyStatus({ userId, params, tools }) {
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
      return { success: false, error: 'Viewers cannot track applications' }
    }

    // Verify the job belongs to this squad
    const jobResult = await tools.get('jobs', jobId)
    if (!jobResult.success || gData(jobResult)['squadId'] !== squadId) {
      return { success: false, error: 'Job not found in this squad' }
    }

    // Upsert: update if the caller already has an application, create otherwise
    const existing = await tools.query('applications', { where: { jobId, userId }, limit: 1 })
    if (existing.success && existing.data?.records?.length) {
      const rec = existing.data.records[0] as unknown as Record<string, unknown>
      await tools.update('applications', rec['recordId'] as string, { status })
    } else {
      await tools.create('applications', { squadId, jobId, userId, status })
    }

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
    if (!jobResult2.success || gData(jobResult2)['squadId'] !== squadId) {
      return { success: false, error: 'Job not found in this squad' }
    }

    // Cascade: comments → applications → job
    for (const where of [{ jobId }] as const) {
      for (const col of ['comments', 'applications'] as const) {
        let deleted = 100
        while (deleted >= 100) {
          const r = await tools.deleteWhere(col, where, 100)
          deleted = r.success ? (r.data?.deleted ?? 0) : 0
        }
      }
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
    const sd = gData(squadResult)
    const rawIds = sd['memberIds']
    let memberIds: string[] = Array.isArray(rawIds)
      ? (rawIds as string[])
      : (() => { try { return JSON.parse(rawIds as string) as string[] } catch { return [] } })()
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
      const data = qData(rec)
      return {
        recordId: rec['recordId'] as string,
        userId:   data['userId']  as string,
        role:     data['role']    as string,
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
    if (!jobResult.success || gData(jobResult)['squadId'] !== squadId) {
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

    // Cascade-delete in dependency order (applications keyed by squadId)
    for (const collection of ['comments', 'applications', 'jobs', 'squadMembers'] as const) {
      let deleted = 100
      while (deleted >= 100) {
        const r = await tools.deleteWhere(collection, { squadId }, 100)
        deleted = r.success ? (r.data?.deleted ?? 0) : 0
      }
    }

    await tools.remove('squads', squadId)
    return { success: true, data: {} }
  },

  /**
   * importJob — scrape a job posting URL and extract structured data with Claude.
   *
   * Pipeline: firecrawl/scrape → anthropic/chat-completion → tools.create('jobs').
   * Requires at least 'member' role.
   *
   * On scrape failure (blocked page, login wall, etc.) the response includes
   * `data.fallbackToText: true` so the UI can drop into the text-paste path.
   *
   * Input:  { squadId, url }
   * Output: { jobId }  |  { fallbackToText: true } on scrape failure
   */
  async importJob({ userId, params, tools }) {
    const { squadId, url } = params as { squadId: string; url: string }

    if (!url?.trim()) return { success: false, error: 'URL is required' }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'Not a member of this squad' }
    if (!roleAtLeast(membership.role, 'member')) {
      return { success: false, error: 'Viewers cannot add jobs' }
    }

    // ── 1. Scrape ──────────────────────────────────────────────────────────
    const scrapeResult = await tools.integration('firecrawl/scrape', {
      url: url.trim(),
      formats: ['markdown'],
      onlyMainContent: true,
    })

    if (!scrapeResult.success) {
      return {
        success: false,
        error: 'Could not reach that page. It may be blocked or require a login. Paste the job description instead.',
        details: { fallbackToText: true },
      }
    }

    const scrapeData = scrapeResult.data as { data?: { markdown?: string } }
    const markdown = scrapeData?.data?.markdown?.trim() ?? ''

    if (markdown.length < 100) {
      return {
        success: false,
        error: 'The page returned too little content to parse. Paste the job description instead.',
        details: { fallbackToText: true },
      }
    }

    return extractAndCreateJob(tools, { squadId, text: markdown, url: url.trim() })
  },

  /**
   * triggerDeadlineReminders — manually run the deadline-reminder job.
   *
   * Owner-only.  Use this to test the reminder emails without waiting for the
   * daily 09:00 UTC cron trigger.  Temporarily set a job's deadline to today
   * or tomorrow, then call this action.
   *
   * Input:  {}
   * Output: {}
   */
  async triggerDeadlineReminders({ userId, env }) {
    if (userId !== env.OWNER_USER_ID) {
      return { success: false, error: 'Owner only' }
    }
    await sendDeadlineReminders(env)
    return { success: true, data: {} }
  },

  /**
   * importJobFromText — extract a job from pasted text using Claude.
   *
   * Fallback path when scraping fails or the user prefers to paste directly.
   * Requires at least 'member' role.
   *
   * Input:  { squadId, text, url? }
   * Output: { jobId }
   */
  async importJobFromText({ userId, params, tools }) {
    const { squadId, text, url } = params as { squadId: string; text: string; url?: string }

    if (!text?.trim() || text.trim().length < 50) {
      return { success: false, error: 'Please paste more of the job description (at least 50 characters).' }
    }

    const membership = await getMembership(tools, userId, squadId)
    if (!membership) return { success: false, error: 'Not a member of this squad' }
    if (!roleAtLeast(membership.role, 'member')) {
      return { success: false, error: 'Viewers cannot add jobs' }
    }

    return extractAndCreateJob(tools, { squadId, text: text.trim(), url })
  },
}
