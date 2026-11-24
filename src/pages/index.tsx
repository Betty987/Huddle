/**
 * Landing page — static, no auth or realtime providers.
 * Prerendered to HTML so crawlers and link previews get real content.
 */

import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div
        data-testid="static-landing"
        className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center"
      >
        <div className="space-y-3">
          <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">Huddle</p>
          <h1 className="max-w-xl text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            Hunt together,<br />land faster.
          </h1>
          <p className="mx-auto max-w-md text-muted-foreground">
            A shared job board for your friend group. Add postings, track where
            everyone stands, and cheer each other on — all in real time.
          </p>
        </div>

        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Link
            to="/dashboard"
            className="inline-flex items-center rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <Link
            to="/dashboard"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign in
          </Link>
        </div>

        <ul className="mt-6 grid grid-cols-1 gap-4 text-left sm:grid-cols-3 max-w-2xl w-full">
          {[
            { title: 'Shared board', body: 'Everyone in your squad sees new postings the moment they land.' },
            { title: 'Role-based access', body: 'Owners manage the squad. Members track. Viewers read-only.' },
            { title: 'Deadline alerts', body: 'Email reminders 48 hours before an application closes.' },
          ].map((f) => (
            <li key={f.title} className="rounded-lg border border-border bg-card p-4">
              <p className="font-medium text-foreground">{f.title}</p>
              <p className="mt-1 text-sm text-muted-foreground">{f.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
