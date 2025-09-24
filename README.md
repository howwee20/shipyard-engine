# Shipyard Engine v1

Shipyard Engine turns structured human tickets into GitHub pull requests that are ready to auto-merge. Provide a ticket file, the engine gathers repository context, asks the configured LLM provider (OpenAI by default) for minimal edits or applies literal SafeReplace edits, commits them on a feature branch, opens a PR, and attempts to arm auto-merge.

## Prerequisites

- Node.js 22+
- npm to install dependencies
- Repository with "Allow auto-merge" enabled or the optional scripted merge fallback
- GitHub token with `contents:write`, `pull_requests:write`, and `metadata:read` access (a classic PAT with `repo` scope works)
- Credentials for your selected LLM provider (OpenAI by default)
- Branch protection that requires at least one check (the bundled smoke workflow can satisfy this)
- Vercel (or another CI) PR previews recommended; if unavailable, the smoke workflow provides a minimal required check

## Installation

```bash
npm install
```

## Environment configuration

Copy `.env.example` to `.env` and fill in the values:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
ANTHROPIC_VERSION=2023-06-01
ANTHROPIC_BASE_URL=https://api.anthropic.com
GITHUB_TOKEN=ghp_...
GITHUB_OWNER=your-github-handle
GITHUB_REPO=bloom
GITHUB_BASE_BRANCH=main
VERIFY_STRICT=true
```

- `OPENAI_MODEL` defaults to `gpt-4.1-mini` if omitted.
- `GITHUB_REPO` defaults to `bloom`; override when pointing at a different repository.
- `GITHUB_BASE_BRANCH` defaults to `main`.
- `GITHUB_OWNER` and `GITHUB_TOKEN` are always required.
- `LLM_PROVIDER` defaults to `openai`; set to `anthropic` to use Claude instead.
- When `LLM_PROVIDER=anthropic`, provide `ANTHROPIC_API_KEY` and optionally override `ANTHROPIC_MODEL`, `ANTHROPIC_VERSION`, or `ANTHROPIC_BASE_URL`.
- `VERIFY_STRICT` controls the Sanity Rails check (see below) and should remain `true` unless you fully trust downstream safeguards.

## LLM provider switch

Shipyard Engine now routes all model calls through a provider-agnostic adapter. By default it continues to use OpenAI, but you can flip to Anthropic (Claude) by exporting:

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
```

The OpenAI environment variables remain supported, so you can swap providers by changing `LLM_PROVIDER` and supplying the corresponding credentials. `ANTHROPIC_VERSION` and `ANTHROPIC_BASE_URL` default to Anthropic's hosted API but can be overridden for self-hosted gateways.

## SafeReplace mode

For deterministic, low-risk edits you can bypass the LLM entirely with a `safe_replace` block inside the ticket YAML. Provide literal `find`/`replace` pairs and the engine will apply them sequentially to the base branch content:

```yaml
safe_replace:
  - path: src/app/layout.tsx
    replacements:
      - find: "text-orange-500"
        replace: "text-purple-500"
      - find: "bg-orange-50"
        replace: "bg-purple-50"
```

If any `find` token is missing the engine logs the omission and leaves the file untouched. When at least one replacement succeeds, the updated files continue through the normal validation, commit, and PR flow.

## Sanity Rails

Before committing, the engine runs a strict sanity check on every modified file (unless `VERIFY_STRICT=false`). It rejects updates that are empty, exceed 200 KB, contain disallowed control characters, or strip required exports from `src/app/layout.tsx` or `src/app/components/NowPlaying.tsx`. Failures abort the run with a `SanityRails` error message—only disable the guardrail if you have redundant protections downstream.

The non-printable filter blocks characters that match `/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/`, allowing normal UTF-8 while guarding against control characters and the Unicode replacement glyph.

`src/app/layout.tsx` passes when it contains either `export default function RootLayout(` or `export default RootLayout`. `src/app/components/NowPlaying.tsx` passes when it contains any of `export default function NowPlaying`, `export default NowPlaying`, or `export default memo(NowPlaying)`.

SafeReplace emits informational messages when a `find` token is missing (e.g., `SafeReplace: token not found <token> in <path>`) and logs how many tokens it actually replaces per file; these messages do not fail the run.

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

A ready-to-run smoke ticket lives at `tickets/color-orange.md`; omit `--ticket` to fall back to `tickets/sample.md`.

## Run

```bash
npm start -- --ticket tickets/color-orange.md
```

Set the following environment variables before running:

- `LLM_PROVIDER` (defaults to `openai`)
- `OPENAI_API_KEY` (required when `LLM_PROVIDER=openai`)
- `ANTHROPIC_API_KEY` (required when `LLM_PROVIDER=anthropic`)
- `GITHUB_TOKEN`
- `GITHUB_OWNER`
- `GITHUB_REPO` (defaults to `bloom`)
- `GITHUB_BASE_BRANCH` (defaults to `main`)
- `OPENAI_MODEL` (optional, defaults to `gpt-4.1-mini`)

The target repository (for example, `bloom`) must have Vercel PR previews configured and native auto-merge enabled with at least one required check so the engine can arm auto-merge.

Run via `npm start` or directly with Node if you need a custom ticket path.

```bash
node orchestrator.js --ticket path/to/ticket.md
```

### What the engine does

1. Reads and validates the ticket (`1/7 read ticket…`).
2. Fetches the current contents of each scope file from the base branch (`2/7 fetch scope files…`).
3. Either executes literal SafeReplace edits or calls the configured LLM provider with the ticket and file context (`3/7 safe replace…` or `3/7 call LLM…`).
4. Runs Sanity Rails (unless disabled) to catch suspicious output before committing (`4/7 run sanity rails…`).
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
| `JSON invalid` / `Model attempted to modify path outside scope` | LLM output rejected by safety checks | Re-run, refine scope, or adjust guardrails |
| `Branch already exists` | Generated branch name already present | Delete the branch or edit the ticket title |
| `Auto-merge not enabled: ...` | Repository disallows auto-merge or token lacks scope | Enable auto-merge in repo settings or supply a token with `pull_request:write` |
| GitHub `403`/`404` errors | Token lacks permissions or repository/branch incorrect | Confirm env vars and token scopes |

## Scripts

- `npm start` – run the orchestrator
- `npm run tickets:sample` – quick pointer to the bundled ticket example

## Optional scripted merge fallback

Set `USE_SCRIPTED_MERGE=true` and configure `MERGE_CHECK_NAME` when implementing a polling merge fallback. This build does not enable the fallback by default; auto-merge remains the primary path.
