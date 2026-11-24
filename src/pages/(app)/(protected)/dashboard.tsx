/**
 * Dashboard — lists the user's squads, with modals to create or join one.
 *
 * Data model: useQuery returns RecordData<T>[] where fields live in record.data.
 * System fields (recordId, createdBy, createdAt) are on the wrapper itself.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from 'deepspace'
import type { RecordData } from 'deepspace'
import { Users, Plus, LogIn, ArrowRight, Copy, Check } from 'lucide-react'
import {
  Button, Input, Label, Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogFooter,
} from '@/components/ui'
import { callAction } from '@/lib/actions'
import { useToast } from '@/components/ui'

type SquadData = { name: string; inviteCode: string; memberIds: string }

export default function DashboardPage() {
  const { records: squads, status: squadsStatus } = useQuery<SquadData>('squads', {})
  const { success: toastSuccess, error: toastError } = useToast()

  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)

  if (squadsStatus === 'loading') {
    return (
      <div className="flex h-64 items-center justify-center text-muted-foreground text-sm">
        Loading squads…
      </div>
    )
  }

  // squads is already pre-filtered by the server via collaboratorsField —
  // the DO only streams squad records where the caller's userId is in memberIds.
  const mySquads = squads

  const getMemberCount = (squad: RecordData<SquadData>) => {
    try { return (JSON.parse(squad.data.memberIds) as string[]).length } catch { return 0 }
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">My Squads</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Each squad is a shared job board for a group of friends.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => setShowJoin(true)}>
            <LogIn className="h-4 w-4" aria-hidden />
            Join
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Create
          </Button>
        </div>
      </div>

      {mySquads.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Users className="mx-auto h-10 w-10 text-muted-foreground/50" />
          <p className="mt-3 text-sm font-medium text-foreground">No squads yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a squad and invite friends, or join one with an invite code.
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setShowJoin(true)}>
              Join a squad
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              Create a squad
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {mySquads.map((squad) => (
            <SquadCard
              key={squad.recordId}
              squad={squad}
              memberCount={getMemberCount(squad)}
              onCopyCode={() => {
                navigator.clipboard
                  .writeText(squad.data.inviteCode)
                  .then(() =>
                    toastSuccess(
                      'Copied!',
                      `Share code ${squad.data.inviteCode} with your friends`,
                    ),
                  )
              }}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateSquadModal
          onClose={() => setShowCreate(false)}
          onCreated={(squadId) => {
            setShowCreate(false)
            toastSuccess('Squad created!', 'Share the invite code with your friends')
            window.location.href = `/squad/${squadId}`
          }}
          onError={(msg) => toastError('Failed', msg)}
        />
      )}

      {showJoin && (
        <JoinSquadModal
          onClose={() => setShowJoin(false)}
          onJoined={(squadId, name) => {
            setShowJoin(false)
            toastSuccess(`Joined ${name}!`, '')
            window.location.href = `/squad/${squadId}`
          }}
          onError={(msg) => toastError('Failed', msg)}
        />
      )}
    </div>
  )
}

function SquadCard({
  squad,
  memberCount,
  onCopyCode,
}: {
  squad: RecordData<SquadData>
  memberCount: number
  onCopyCode: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    onCopyCode()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 transition-shadow hover:shadow-sm">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="font-semibold text-foreground">{squad.data.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {memberCount} member{memberCount !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={handleCopy}
          title="Copy invite code"
          className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {squad.data.inviteCode}
        </button>
      </div>
      <Link
        to={`/squad/${squad.recordId}`}
        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      >
        Open board <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )
}

function CreateSquadModal({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void
  onCreated: (squadId: string) => void
  onError: (msg: string) => void
}) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    const res = await callAction<{ squadId: string; inviteCode: string }>('createSquad', { name })
    setLoading(false)
    if (res.success && res.data?.squadId) {
      onCreated(res.data.squadId)
    } else {
      onError(res.error ?? 'Unknown error')
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a squad</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="squad-name">Squad name</Label>
            <Input
              id="squad-name"
              placeholder="e.g. Fall 2026 SWE Grind"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading}>
              {loading ? 'Creating…' : 'Create squad'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function JoinSquadModal({
  onClose,
  onJoined,
  onError,
}: {
  onClose: () => void
  onJoined: (squadId: string, name: string) => void
  onError: (msg: string) => void
}) {
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!code.trim()) return
    setLoading(true)
    const res = await callAction<{ squadId: string; name: string }>('joinSquad', {
      inviteCode: code.trim().toUpperCase(),
    })
    setLoading(false)
    if (res.success && res.data) {
      onJoined(res.data.squadId, res.data.name)
    } else {
      onError(res.error ?? 'Unknown error')
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join a squad</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="invite-code">Invite code</Label>
            <Input
              id="invite-code"
              placeholder="e.g. AB3XYZ"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoFocus
              maxLength={8}
              className="font-mono uppercase"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!code.trim() || loading}>
              {loading ? 'Joining…' : 'Join squad'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
