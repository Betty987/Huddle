# Huddle

A shared job-hunt board for friend groups. Add job postings, track where
everyone stands in the pipeline, and cheer each other on — all in real time.

## What it does

Each **squad** is a private board shared with a group. Any member can paste a
job link and Claude extracts the title, company, deadline, and sponsorship
details automatically. Everyone then tracks their own application status
independently — your "Applied" doesn't affect anyone else's "Saved".

### Features

- **Import from link** — paste a Greenhouse, Lever, or company careers URL;
  Firecrawl scrapes it and Claude Haiku extracts the structured fields. If the
  page is behind a login wall it falls back to a text-paste mode.
- **Per-person Kanban** — Saved → Applied → OA → Interview → Offer / Rejected.
  Each member moves their own card; the board shows squad progress inline
  ("2 applied · 1 OA").
- **Team tracker** — click any job to see every member's current status and
  leave threaded comments.
- **Deadline alerts** — a daily cron job emails members who haven't applied yet
  48 hours before an application closes. Sends once per job, never duplicates.
- **Role-based access** — Owners manage the squad. Members track. Viewers are
  read-only, enforced server-side in actions (not just the UI).
- **Invite codes** — 6-character codes to share; join from the dashboard.

## Stack

Built on [DeepSpace](https://deepspace.dev) — Cloudflare Workers + Durable
Objects for real-time sync and server actions.

| Integration | Used for |
|-------------|----------|
| Firecrawl | Scraping job posting pages |
| Anthropic Claude Haiku | Extracting structured fields from scraped markdown |
| DeepSpace `email/send` | 48-hour deadline reminder emails |

## Running locally

```bash
npm install
npx deepspace dev
```

Open `http://localhost:5173`.

## Deploying

```bash
npx deepspace deploy
```

## Project structure

```
src/
  actions/index.ts          # All server actions (RBAC enforced here)
  schemas/                  # Collection schemas — single source of truth
  cron.ts                   # Deadline reminder cron task
  pages/
    index.tsx               # Landing page (prerendered)
    (app)/
      sign-in.tsx
      (protected)/
        dashboard.tsx       # Squad list
        squad/[squadId].tsx # Board, import, detail panel, members
```

## Tradeoffs

- **Per-person status lives in `applications`**, not on the job record. This
  means a job card doesn't have a single status — each member has their own.
  The Kanban groups by *my* status; squad progress is a summary computed
  client-side from the full applications list.
- **Jobs are readable by any authenticated user** (not gated by `collaboratorsField`).
  For a small-group trust tool this is an acceptable tradeoff; the
  `collaboratorsField` approach would require re-fetching on every squad switch.
- **Import is best-effort** — Firecrawl can't scrape pages behind login walls
  (LinkedIn, Workday). The fallback text-paste path covers those cases.
