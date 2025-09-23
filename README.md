# Shipyard Engine v1

Shipyard Engine turns structured human tickets into GitHub pull requests that are ready to auto-merge. Provide a ticket file, the engine gathers repository context, asks OpenAI for minimal edits, commits them on a feature branch, opens a PR, and attempts to arm auto-merge.

## Prerequisites

- Node.js 22+
- npm to install dependencies
- Repository with "Allow auto-merge" enabled or the optional scripted merge fallback
- GitHub token with `contents:write`, `pull_requests:write`, and `metadata:read` access (a classic PAT with `repo` scope works)
- OpenAI API key with access to the selected `OPENAI_MODEL`
- Branch protection that requires at least one check (the bundled smoke workflow can satisfy this)
- Vercel (or another CI) PR previews recommended; if unavailable, the smoke workflow provides a minimal required check

## Installation

```bash
npm install
```

## Environment configuration

Copy `.env.example` to `.env` and fill in the values:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-github-handle
GITHUB_REPO=bloom
GITHUB_BASE_BRANCH=main
```

- `OPENAI_MODEL` defaults to `gpt-4.1-mini` if omitted.
- `GITHUB_REPO` defaults to `bloom`; override when pointing at a different repository.
- `GITHUB_BASE_BRANCH` defaults to `main`.
- `GITHUB_OWNER` and `GITHUB_TOKEN` are always required.

## Ticket format

Tickets can be Markdown or YAML. Provide either YAML front-matter, a fenced `yaml` block, or a `# shipyard:ticket` heading followed by YAML fields. Required keys: `title`, `why`, `scope`, and `dod`. `guardrails` is optional.

Example (`tickets/sample.md`):

```markdown
# shipyard:ticket

title: "Change header brand color to purple"
why: "Visual smoke"
scope:
  - src/app/layout.tsx
dod:
  - "Header link class uses text-purple-500"
guardrails:
  - "Touch only files listed in scope"
```

## Usage

Run via `npm start` or directly with Node. If `--ticket` is omitted, the sample ticket is used.

```bash
npm start -- --ticket tickets/sample.md
# or
node orchestrator.js --ticket path/to/ticket.md
```

### What the engine does

1. Reads and validates the ticket (`1/7 read ticket…`).
2. Fetches the current contents of each scope file from the base branch (`2/7 fetch scope files…`).
3. Calls OpenAI with the ticket and file context, enforcing a strict JSON contract (`3/7 call OpenAI…`).
4. Validates the JSON payload, rejecting paths outside scope, invalid base64, or >5 files (`4/7 validate JSON…`).
5. Creates a feature branch named `intent-<slug(title)>-<shortid>` (`5/7 create branch…`).
6. Commits the AI-provided edits with messages prefixed by `shipyard:` (`6/7 commit…`).
7. Opens a PR, posts the ticket YAML in the body, and attempts to enable auto-merge (`7/7 open PR + arm auto-merge…`).

On success the CLI prints the PR URL. Auto-merge failures (e.g., repository setting disabled) are logged but do not halt execution.

## Smoke workflow

The repository includes `.github/workflows/smoke.yml`, a minimal check that always succeeds. Configure branch protection to require this check so auto-merge can arm even if other CI (e.g., Vercel) is unavailable.

## Failure modes & troubleshooting

| Message | Meaning | Fix |
| --- | --- | --- |
| `Missing required env var` | Required environment variable not set | Populate `.env` or export the variable |
| `Ticket scope must be a non-empty array` | Ticket missing `scope` entries | Update ticket file |
| `Scope path not found in base branch` | File listed in scope missing from base branch | Update scope or create file manually |
| `Scope path is a directory, expected file` | Directory scopes not yet supported | Point to specific files |
| `JSON invalid` / `Model attempted to modify path outside scope` | OpenAI output rejected by safety checks | Re-run, refine scope, or adjust guardrails |
| `Branch already exists` | Generated branch name already present | Delete the branch or edit the ticket title |
| `Auto-merge not enabled: ...` | Repository disallows auto-merge or token lacks scope | Enable auto-merge in repo settings or supply a token with `pull_request:write` |
| GitHub `403`/`404` errors | Token lacks permissions or repository/branch incorrect | Confirm env vars and token scopes |

## Scripts

- `npm start` – run the orchestrator
- `npm run tickets:sample` – quick pointer to the bundled ticket example

## Optional scripted merge fallback

Set `USE_SCRIPTED_MERGE=true` and configure `MERGE_CHECK_NAME` when implementing a polling merge fallback. This build does not enable the fallback by default; auto-merge remains the primary path.
