# Company templates

A template is a company in a box: one `roster.yaml` (who is on the multi-agent
team) plus one `goals.md` (what the PM should be aiming at). Build a real setup
once, `save` it as a template, and reuse it.

## Using it

```bash
node scripts/company-template.mjs list                 # what's available
node scripts/company-template.mjs show content-studio  # roster + goals
node scripts/company-template.mjs apply content-studio # overwrite this machine's roster
node scripts/company-template.mjs save <new-name>      # save the current roster as a template
```

## In the office — the "Company in a box" panel

The button in the top-right opens a list of templates with their departments,
headcount, and a warning for any skill they need that this machine lacks. Apply
takes two clicks before it overwrites anything.

The daemon serves `GET /templates` and `POST /templates/apply`, sharing its
logic with the CLI through `scripts/company-template-lib.mjs`. Details in
[templates-panel-status.md](templates-panel-status.md).

## apply — install a template on this machine

1. If `~/.claude/company/roster.yaml` exists, copy it to a timestamped `.bak`
   and print the path.
2. Write `templates/<name>/roster.yaml` over `~/.claude/company/roster.yaml`.
3. Scan `~/.claude/skills` and `~/.claude/agents`, and list any skill the
   template needs that isn't installed. Plugin-sourced members can't be checked
   this way and are assumed present.
4. Print `goals.md`.

For anything missing, run the **`company-hire` skill**, which requires a safety
scan and does not offer a bypass. A template only runs smoothly once every
member it names is installed.

## save — package a real setup as a template

Copies `~/.claude/company/roster.yaml` to `templates/<name>/roster.yaml`. Write
`templates/<name>/goals.md` yourself afterwards.

## The bundled templates

- **content-studio** — a one-person content studio: three departments (`media`,
  `marketing`, `research`) built entirely from installed skills.
- **real-estate-marketing** — a real-estate marketing team, in a general form
  with no client attached: five departments (`marketing`, `media`, `research`,
  `social`, `ops`). Its `goals.md` carries a table of BLANKS to fill in per
  client and a "needs hiring" table for capabilities the roster doesn't cover
  yet. See [template-realestate-status.md](template-realestate-status.md).
- **coding** — the software-delivery roster.

## Things worth knowing

- The CLI never touches the daemon or renderer; it only reads and writes
  `templates/` and `~/.claude/company/`. The dependency runs one way: the daemon
  imports `company-template-lib.mjs`, not the reverse.
- `apply` overwrites the real roster. There is always a timestamped `.bak`, and
  a second apply does not clobber the first backup — but check what you're doing
  before applying on the machine you actually work on.
- A template name must match `^[a-z0-9-]+$` and be a real directory under
  `templates/`. That holds for `apply`, `show`, `save`, and the daemon routes
  alike.
