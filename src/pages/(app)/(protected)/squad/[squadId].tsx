/**
 * Squad board — per-person Kanban for a squad's job cards.
 *
 * Data model:
 *   jobs         — shared postings (title, company, etc.) — no meaningful status
 *   applications — per-person status: { squadId, jobId, userId, status }
 *
 * Board shows MY status column.  Jobs with no application record appear in Saved.
 * Cards show a squad progress summary ("2 applied · 1 OA").
 * Job detail panel lists every member's current status and all comments.
 *
 * RBAC: setMyStatus and job mutations call server actions which re-check the
 * caller's squad role server-side.  Viewers see the board but cannot write.
 */

import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useMutations, useAuth, useUserLookup } from 'deepspace'
import type { RecordData } from 'deepspace'
import {
  ArrowLeft, Plus, ExternalLink, Trash2, MessageSquare, ChevronDown, Users,
} from 'lucide-react'
import {
  Button, Input, Label, Textarea, Dialog, DialogContent,
  DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui'
import { callAction } from '@/lib/actions'
import { useToast } from '@/components/ui'
import { cn } from '@/lib/utils'

// ── Data types (fields only — recordId / createdBy / createdAt on wrapper) ───

type MemberInfo      = { recordId: string; userId: string; role: string }
type SquadData       = { name: string; inviteCode: string; memberIds: string }
type JobData         = {
  squadId: string; title: string; company: string; url: string
  roleType: string; deadline: string; sponsorship: string; notes: string
}
type ApplicationData = { squadId: string; jobId: string; userId: string; status: string }
type CommentData     = { jobId: string; squadId: string; body: string }

// ── Kanban columns ────────────────────────────────────────────────────────────

const COLUMNS = [
  { id: 'saved',     label: 'Saved' },
  { id: 'applied',   label: 'Applied' },
  { id: 'oa',        label: 'OA' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer',     label: 'Offer' },
  { id: 'rejected',  label: 'Rejected' },
]

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SquadPage() {
  const { squadId } = useParams<{ squadId: string }>()
  const { userId } = useAuth()
  const { error: toastError } = useToast()

  const { records: squads, status: squadsStatus } = useQuery<SquadData>('squads', {})
  const { records: jobs }            = useQuery<JobData>('jobs', { where: { squadId } })
  const { records: allApplications } = useQuery<ApplicationData>('applications', { where: { squadId } })

  const [showAddJob, setShowAddJob]   = useState(false)
  const [selectedJob, setSelectedJob] = useState<RecordData<JobData> | null>(null)
  const [showMembers, setShowMembers] = useState(false)
  const [myRole, setMyRole]   = useState<string | null>(null)
  const [members, setMembers] = useState<MemberInfo[]>([])

  const refreshMembers = () => {
    if (!squadId) return
    callAction<{ members: MemberInfo[]; myRole: string }>('listMembers', { squadId }).then((res) => {
      if (res.success && res.data) {
        setMyRole(res.data.myRole)
        setMembers(res.data.members)
      }
    })
  }

  useEffect(() => { refreshMembers() }, [squadId])

  const squad    = squads.find((s) => s.recordId === squadId)
  const canWrite = myRole === 'owner' || myRole === 'member'

  // My personal status per job: Map<jobId, status>
  const myStatusMap = new Map(
    allApplications
      .filter((a) => a.data.userId === userId)
      .map((a) => [a.data.jobId, a.data.status]),
  )

  // Squad-level progress per job: Map<jobId, Record<status, count>>
  const squadProgressMap = new Map<string, Record<string, number>>()
  for (const app of allApplications) {
    if (!squadProgressMap.has(app.data.jobId)) squadProgressMap.set(app.data.jobId, {})
    const counts = squadProgressMap.get(app.data.jobId)!
    counts[app.data.status] = (counts[app.data.status] ?? 0) + 1
  }

  if (squadsStatus === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    )
  }

  if (!squad) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
        <p>Squad not found or you don&apos;t have access.</p>
        <Link to="/dashboard" className="text-sm text-primary hover:underline">
          Back to dashboard
        </Link>
      </div>
    )
  }

  const handleSetStatus = async (jobId: string, newStatus: string) => {
    const res = await callAction('setMyStatus', { jobId, squadId, status: newStatus })
    if (!res.success) toastError('Could not update status', res.error ?? '')
  }

  const handleDeleteJob = async (jobId: string) => {
    const res = await callAction('deleteJob', { jobId, squadId })
    if (!res.success) toastError('Could not delete', res.error ?? '')
    else if (selectedJob?.recordId === jobId) setSelectedJob(null)
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-3">
        <Link
          to="/dashboard"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Squads
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-medium text-foreground">{squad.data.name}</span>
        <div className="flex-1" />
        {myRole && (
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
            {myRole}
          </span>
        )}
        <Button variant="secondary" size="sm" onClick={() => setShowMembers(true)}>
          <Users className="h-4 w-4" aria-hidden />
          Members
        </Button>
        {canWrite && (
          <Button size="sm" onClick={() => setShowAddJob(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Add job
          </Button>
        )}
      </div>

      {/* Kanban — columns are MY status */}
      <div className="flex flex-1 gap-3 overflow-x-auto p-4">
        {COLUMNS.map((col) => {
          const colJobs = jobs.filter((j) => (myStatusMap.get(j.recordId) ?? 'saved') === col.id)
          return (
            <div key={col.id} className="flex w-64 shrink-0 flex-col gap-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {col.label}
                </span>
                <span className="text-xs text-muted-foreground">{colJobs.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {colJobs.map((job) => (
                  <JobCard
                    key={job.recordId}
                    job={job}
                    myStatus={myStatusMap.get(job.recordId) ?? 'saved'}
                    squadProgress={squadProgressMap.get(job.recordId) ?? {}}
                    canWrite={canWrite}
                    onSetStatus={handleSetStatus}
                    onDelete={handleDeleteJob}
                    onClick={() => setSelectedJob(job)}
                    isSelected={selectedJob?.recordId === job.recordId}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {showAddJob && (
        <AddJobModal
          squadId={squadId!}
          onClose={() => setShowAddJob(false)}
          onAdded={() => setShowAddJob(false)}
          onError={(msg) => toastError('Failed to add job', msg)}
        />
      )}

      {showMembers && (
        <MembersPanel
          squadId={squadId!}
          userId={userId!}
          myRole={myRole}
          members={members}
          onRefresh={refreshMembers}
          onClose={() => setShowMembers(false)}
        />
      )}

      {selectedJob && (
        <JobDetailPanel
          job={selectedJob}
          squadId={squadId!}
          canWrite={canWrite}
          applications={allApplications.filter((a) => a.data.jobId === selectedJob.recordId)}
          members={members}
          onClose={() => setSelectedJob(null)}
        />
      )}
    </div>
  )
}

// ── JobCard ───────────────────────────────────────────────────────────────────

function JobCard({
  job, myStatus, squadProgress, canWrite, onSetStatus, onDelete, onClick, isSelected,
}: {
  job: RecordData<JobData>
  myStatus: string
  squadProgress: Record<string, number>
  canWrite: boolean
  onSetStatus: (jobId: string, status: string) => void
  onDelete: (jobId: string) => void
  onClick: () => void
  isSelected: boolean
}) {
  const [showMoveMenu, setShowMoveMenu] = useState(false)
  const { data } = job

  const daysUntil = data.deadline
    ? Math.ceil((new Date(data.deadline).getTime() - Date.now()) / 86_400_000)
    : null
  const urgent = daysUntil !== null && daysUntil <= 3

  // Squad progress line — skip 'saved' (it's the untracked default, uninteresting)
  const progressSummary = COLUMNS
    .filter((c) => c.id !== 'saved' && (squadProgress[c.id] ?? 0) > 0)
    .map((c) => `${squadProgress[c.id]} ${c.label.toLowerCase()}`)
    .join(' · ')

  return (
    <div
      className={cn(
        'group relative cursor-pointer rounded-lg border bg-card p-3 text-sm transition-shadow hover:shadow-sm',
        isSelected ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onClick()}
    >
      <p className="pr-10 font-medium leading-snug text-foreground">{data.title || '—'}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{data.company || '—'}</p>

      {progressSummary && (
        <p className="mt-1 text-[10px] text-muted-foreground/70">{progressSummary}</p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {data.sponsorship === 'yes' && (
          <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
            Sponsors
          </span>
        )}
        {data.sponsorship === 'no' && (
          <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-400">
            No sponsor
          </span>
        )}
        {data.deadline && (
          <span
            className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
              urgent
                ? 'bg-orange-500/10 text-orange-700 dark:text-orange-400'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {daysUntil !== null && daysUntil < 0
              ? 'Closed'
              : daysUntil === 0
              ? 'Due today'
              : data.deadline}
          </span>
        )}
      </div>

      {canWrite && (
        <div
          className={cn(
            'absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100',
            isSelected && 'opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative">
            <button
              title="Set my status"
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setShowMoveMenu((v) => !v)}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {showMoveMenu && (
              <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-border bg-popover py-1 shadow-lg">
                {COLUMNS.filter((c) => c.id !== myStatus).map((c) => (
                  <button
                    key={c.id}
                    className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                    onClick={() => { onSetStatus(job.recordId, c.id); setShowMoveMenu(false) }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            title="Delete job"
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onDelete(job.recordId)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}

// ── AddJobModal ───────────────────────────────────────────────────────────────

function AddJobModal({
  squadId, onClose, onAdded, onError,
}: {
  squadId: string
  onClose: () => void
  onAdded: () => void
  onError: (msg: string) => void
}) {
  const [form, setForm] = useState({
    title: '', company: '', url: '',
    roleType: 'full-time', deadline: '', sponsorship: 'unknown', notes: '',
  })
  const [loading, setLoading] = useState(false)

  const set = (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.company.trim()) return
    setLoading(true)
    const res = await callAction('addJob', { squadId, ...form })
    setLoading(false)
    if (res.success) onAdded()
    else onError(res.error ?? 'Unknown error')
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a job</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="aj-title">Job title *</Label>
              <Input id="aj-title" placeholder="SWE Intern" value={form.title} onChange={set('title')} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="aj-company">Company *</Label>
              <Input id="aj-company" placeholder="Acme Corp" value={form.company} onChange={set('company')} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="aj-url">Job URL</Label>
            <Input id="aj-url" type="url" placeholder="https://…" value={form.url} onChange={set('url')} />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="aj-type">Type</Label>
              <select
                id="aj-type"
                value={form.roleType}
                onChange={set('roleType')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="internship">Internship</option>
                <option value="full-time">Full-time</option>
                <option value="part-time">Part-time</option>
                <option value="contract">Contract</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="aj-deadline">Deadline</Label>
              <Input id="aj-deadline" type="date" value={form.deadline} onChange={set('deadline')} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="aj-sponsor">Sponsorship</Label>
              <select
                id="aj-sponsor"
                value={form.sponsorship}
                onChange={set('sponsorship')}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="unknown">Unknown</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="aj-notes">Notes</Label>
            <Textarea
              id="aj-notes"
              placeholder="Referral contact, good team culture, etc."
              rows={2}
              value={form.notes}
              onChange={set('notes') as React.ChangeEventHandler<HTMLTextAreaElement>}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!form.title.trim() || !form.company.trim() || loading}>
              {loading ? 'Adding…' : 'Add job'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── JobDetailPanel ────────────────────────────────────────────────────────────

function JobDetailPanel({
  job, squadId, canWrite, applications, members, onClose,
}: {
  job: RecordData<JobData>
  squadId: string
  canWrite: boolean
  applications: RecordData<ApplicationData>[]
  members: MemberInfo[]
  onClose: () => void
}) {
  const { userId } = useAuth()
  const { getName } = useUserLookup()
  const { records: comments } = useQuery<CommentData>('comments', {
    where: { jobId: job.recordId },
    orderBy: 'createdAt',
    orderDir: 'asc',
  })
  const { remove: removeComment } = useMutations<CommentData>('comments')
  const [body, setBody] = useState('')
  const [posting, setPosting] = useState(false)

  const { data } = job

  const memberName = (uid: string | undefined) => {
    if (!uid) return '(unknown)'
    if (uid === userId) return 'You'
    return getName(uid) ?? uid.slice(0, 8) + '…'
  }

  const handleComment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim() || posting) return
    setPosting(true)
    await callAction('addComment', { jobId: job.recordId, squadId, body: body.trim() })
    setPosting(false)
    setBody('')
  }

  // Build userId → status map for this job
  const appByUser = new Map(applications.map((a) => [a.data.userId, a.data.status]))

  return (
    <div className="fixed inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-border bg-background shadow-xl">
      {/* Header */}
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-foreground">{data.title}</h2>
          <p className="text-sm text-muted-foreground">{data.company}</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close panel"
          className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {/* Job details */}
        <dl className="space-y-3 text-sm">
          {data.url && (
            <div>
              <dt className="text-xs text-muted-foreground">URL</dt>
              <dd>
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Open posting <ExternalLink className="h-3 w-3" />
                </a>
              </dd>
            </div>
          )}
          {data.roleType && (
            <div>
              <dt className="text-xs text-muted-foreground">Type</dt>
              <dd className="capitalize text-foreground">{data.roleType.replace('-', ' ')}</dd>
            </div>
          )}
          {data.deadline && (
            <div>
              <dt className="text-xs text-muted-foreground">Deadline</dt>
              <dd className="text-foreground">{data.deadline}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted-foreground">Sponsorship</dt>
            <dd className="capitalize text-foreground">{data.sponsorship}</dd>
          </div>
          {data.notes && (
            <div>
              <dt className="text-xs text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap text-foreground">{data.notes}</dd>
            </div>
          )}
        </dl>

        {/* Team tracker — each member's current status */}
        {members.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Team tracker
            </p>
            <div className="space-y-1.5">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-foreground">{memberName(m.userId)}</span>
                  <span className="shrink-0 capitalize text-muted-foreground">
                    {appByUser.get(m.userId) ?? 'saved'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Comments */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <MessageSquare className="h-3.5 w-3.5" />
            Comments ({comments.length})
          </div>
          <div className="space-y-3">
            {comments.map((c) => (
              <div key={c.recordId} className="group flex gap-2">
                <div className="min-w-0 flex-1 rounded-lg bg-muted px-3 py-2">
                  <p className="text-xs text-muted-foreground">
                    {memberName(c.createdBy)}
                    <span className="ml-2">
                      {new Date(c.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </p>
                  <p className="mt-1 text-sm text-foreground">{c.data.body}</p>
                </div>
                {c.createdBy === userId && (
                  <button
                    onClick={() => removeComment(c.recordId)}
                    aria-label="Delete comment"
                    className="mt-2 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            {comments.length === 0 && (
              <p className="text-xs text-muted-foreground">No comments yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Comment input */}
      {canWrite && (
        <form onSubmit={handleComment} className="flex shrink-0 gap-2 border-t border-border p-3">
          <Input
            placeholder="Add a comment…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="flex-1 text-sm"
          />
          <Button type="submit" size="sm" disabled={!body.trim() || posting}>
            {posting ? 'Posting…' : 'Post'}
          </Button>
        </form>
      )}
    </div>
  )
}

// ── MembersPanel ──────────────────────────────────────────────────────────────

function MembersPanel({
  squadId, userId, myRole, members, onRefresh, onClose,
}: {
  squadId: string
  userId: string
  myRole: string | null
  members: MemberInfo[]
  onRefresh: () => void
  onClose: () => void
}) {
  const { success: toastSuccess, error: toastError } = useToast()
  const { getName } = useUserLookup()

  const displayName = (uid: string | undefined) => {
    if (!uid) return '(unknown)'
    if (uid === userId) return 'You'
    return getName(uid) ?? uid.slice(0, 14) + '…'
  }

  const handleRoleChange = async (targetUserId: string, role: string) => {
    const res = await callAction('changeRole', { squadId, targetUserId, role })
    if (res.success) onRefresh()
    else toastError('Could not update role', res.error ?? '')
  }

  const handleDelete = async () => {
    if (!window.confirm('Permanently delete this squad and all its jobs? This cannot be undone.')) return
    const res = await callAction('deleteSquad', { squadId })
    if (res.success) {
      toastSuccess('Squad deleted', '')
      window.location.href = '/dashboard'
    } else {
      toastError('Could not delete squad', res.error ?? '')
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Squad members</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 py-1">
          {members.map((m) => (
            <div key={m.recordId} className="flex items-center justify-between gap-3">
              <span className="truncate text-sm text-foreground">
                {displayName(m.userId)}
              </span>
              {myRole === 'owner' && m.userId !== userId && m.role !== 'owner' ? (
                <select
                  value={m.role}
                  onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="member">member</option>
                  <option value="viewer">viewer</option>
                </select>
              ) : (
                <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                  {m.role}
                </span>
              )}
            </div>
          ))}
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>

        {myRole === 'owner' && (
          <div className="border-t border-border pt-3">
            <Button
              variant="destructive"
              size="sm"
              className="w-full"
              onClick={handleDelete}
            >
              Delete squad
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
