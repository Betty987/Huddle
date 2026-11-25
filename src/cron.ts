/**
 * Cron task definitions.
 *
 * deadline-reminders — runs daily at 09:00 UTC.
 *
 * Finds every job whose deadline falls within the next 48 hours and whose
 * `remindedAt` field is empty (meaning we haven't sent a reminder yet).
 * For each such job, emails every squad member who is still at 'saved' status
 * (i.e. hasn't applied or moved further in the pipeline).  After attempting
 * all sends for a job, stamps `remindedAt` so the job is never re-processed.
 *
 * Email is sent via the platform's built-in email/send integration, which
 * requires no credentials or sender-domain setup — it sends from
 * notifications@updates.app.space on behalf of the app.
 *
 * Individual send failures are caught and logged; the remaining members for
 * that job still receive their email, and remindedAt is stamped regardless so
 * the job is not re-processed on the next run.
 *
 * Manual trigger for testing: call the `triggerDeadlineReminders` server
 * action (owner-only) from the browser console:
 *
 *   const { callAction } = await import('/src/lib/actions')
 *   await callAction('triggerDeadlineReminders', {})
 *
 * Or use `npx deepspace action triggerDeadlineReminders '{}'` from the CLI.
 */

import type { CronTask } from 'deepspace/worker'
import { buildCronContext } from 'deepspace/worker'
import type { Env } from '../worker.js'

// ── Task registry ─────────────────────────────────────────────────────────────

export const tasks: CronTask[] = [
  {
    name: 'deadline-reminders',
    schedule: '0 9 * * *', // 09:00 UTC every day
    timezone: 'UTC',
  },
]

export async function runTask(name: string, env: Env): Promise<void> {
  if (name === 'deadline-reminders') {
    await sendDeadlineReminders(env)
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

type RawRecord = { recordId: string; data: Record<string, unknown> }

/** Coerce an unknown query result row to RawRecord. */
function toRec(r: unknown): RawRecord {
  const rec = r as { recordId?: unknown; data?: unknown }
  return {
    recordId: (rec.recordId as string) ?? '',
    data: (rec.data as Record<string, unknown>) ?? {},
  }
}

/**
 * Send 48-hour deadline reminder emails.
 * Exported so the `triggerDeadlineReminders` action can call it on demand.
 */
export async function sendDeadlineReminders(env: Env): Promise<void> {
  const ctx = buildCronContext(env, env.OWNER_USER_ID, `app:${env.DEEPSPACE_APP_ID}`)

  // Compare dates at day granularity (UTC midnight) so a deadline of "2026-11-25"
  // means the entire calendar day of Nov 25, not just midnight UTC.
  const todayUtc = new Date()
  todayUtc.setUTCHours(0, 0, 0, 0)
  const cutoffUtc = new Date(todayUtc.getTime() + 2 * 24 * 60 * 60 * 1_000) // today + 2 days

  // ── 1. Find jobs due within 48 hours that haven't been reminded ───────────
  // We fetch all jobs (up to 2000 — Huddle is a small-group tool) and filter
  // in JS because the query API only supports equality, not range predicates.
  const rawJobs = await ctx.records.query('jobs', { limit: 2_000 })
  const dueJobs = rawJobs
    .map(toRec)
    .filter((r) => {
      const deadline = r.data['deadline'] as string | undefined
      if (!deadline) return false
      if (r.data['remindedAt']) return false // already reminded
      // Parse as UTC midnight so "2026-11-25" = the whole day of Nov 25
      const deadlineUtc = new Date(deadline + 'T00:00:00Z')
      return !isNaN(deadlineUtc.getTime()) && deadlineUtc >= todayUtc && deadlineUtc <= cutoffUtc
    })

  if (dueJobs.length === 0) return

  // ── 2. Build a userId → { email, name } map from the users collection ─────
  // Queried once up-front to avoid N lookups in the job loop.
  const rawUsers = await ctx.records.query('users', { limit: 2_000 })
  const userEmail = new Map<string, string>()
  const userName  = new Map<string, string>()
  for (const ru of rawUsers) {
    const u = toRec(ru)
    if (!u.recordId) continue
    const email = u.data['email'] as string | undefined
    if (email) {
      userEmail.set(u.recordId, email)
      userName.set(u.recordId, (u.data['name'] as string | undefined) || email)
    }
  }

  // ── 3. Process each due job ────────────────────────────────────────────────
  for (const job of dueJobs) {
    const squadId  = job.data['squadId'] as string | undefined
    const title    = (job.data['title']   as string | undefined) ?? '(unknown role)'
    const company  = (job.data['company'] as string | undefined) ?? '(unknown company)'
    const deadline = job.data['deadline'] as string
    const jobUrl   = job.data['url'] as string | undefined

    if (!squadId) continue

    // Get all squad members for this job's squad
    const rawMembers = await ctx.records.query('squadMembers', {
      where: { squadId },
      limit: 200,
    })

    // Get application statuses for this specific job
    const rawApps = await ctx.records.query('applications', {
      where: { jobId: job.recordId },
      limit: 500,
    })
    const statusByUser = new Map<string, string>()
    for (const ra of rawApps) {
      const a = toRec(ra)
      const uid    = a.data['userId'] as string | undefined
      const status = a.data['status'] as string | undefined
      if (uid && status) statusByUser.set(uid, status)
    }

    // Email members who are still at 'saved' (default = not yet applied)
    for (const rm of rawMembers) {
      const m      = toRec(rm)
      const userId = m.data['userId'] as string | undefined
      if (!userId) continue

      const status = statusByUser.get(userId) ?? 'saved'
      if (status !== 'saved') continue // already applied or further along

      const email = userEmail.get(userId)
      if (!email) continue // user not found or no email on record

      const name = userName.get(userId) ?? 'there'

      try {
        const result = await ctx.integrations.call('email/send', {
          to:      email,
          subject: `Reminder: ${title} at ${company} closes ${deadline}`,
          html:    buildReminderEmail({ name, title, company, deadline, url: jobUrl }),
        }) as { success?: boolean; error?: string } | undefined
        // integrations.call may return a failure envelope rather than throwing
        if (result?.success === false) {
          console.error(
            `[deadline-reminders] email/send returned error for ${email} (job ${job.recordId}): ${result.error}`,
          )
        }
      } catch (err) {
        // Network / platform throw — log and continue so remaining members still get emailed.
        console.error(`[deadline-reminders] failed to email ${email} for job ${job.recordId}:`, err)
      }
    }

    // Stamp after all sends (success or not) so this job is never re-processed.
    // Members who didn't receive due to a transient failure won't be retried,
    // but no one gets a duplicate email on the next cron run.
    await ctx.records.update('jobs', job.recordId, {
      remindedAt: new Date().toISOString(),
    })
  }
}

// ── Email template ────────────────────────────────────────────────────────────

function buildReminderEmail({
  name, title, company, deadline, url,
}: {
  name: string
  title: string
  company: string
  deadline: string
  url?: string
}): string {
  // Only render a link for safe http(s) URLs — blocks javascript: and data: schemes.
  const safeUrl = url && /^https?:\/\//i.test(url) ? url : null
  const link = safeUrl
    ? `<p><a href="${escHtml(safeUrl)}" style="color:#6366f1">View job posting →</a></p>`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<body style="font-family:sans-serif;color:#111;max-width:480px;margin:32px auto;padding:0 16px">
  <h2 style="margin:0 0 16px">⏰ Deadline coming up</h2>
  <p>Hi ${escHtml(name)},</p>
  <p>
    The application deadline for <strong>${escHtml(title)}</strong>
    at <strong>${escHtml(company)}</strong> is
    <strong>${escHtml(deadline)}</strong> — that's within the next 48 hours.
  </p>
  <p>You haven't applied yet. Don't miss it!</p>
  ${link}
  <p style="margin-top:40px;font-size:12px;color:#888">
    Sent by Huddle. You're receiving this because you're in a squad tracking this job.
  </p>
</body>
</html>`
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
