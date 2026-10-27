# Contributing

## What this project is

A personal project, built and maintained by one person in spare time, shared
because it might be useful to you too. That shapes what contributing looks like:

- **Issues are welcome**, including "this didn't work on my machine".
- **Replies are best-effort.** Days, sometimes weeks. No SLA.
- **Large PRs may not be merged** even when they are good work. Please open an
  issue before building anything substantial, so neither of us wastes an
  afternoon.

Small, focused PRs — a bug fix, a platform quirk, a doc correction — are the
easiest thing to say yes to.

## Getting set up

Node 20 or newer.

```bash
git clone https://github.com/h3nryprod01/agent-office && cd agent-office
npm --prefix packages/daemon install
npm --prefix packages/renderer install
```

Run the daemon and the renderer separately while developing:

```bash
npm --prefix packages/daemon run dev      # tails transcripts, serves :8787
npm --prefix packages/renderer run dev    # Vite on :5199 with hot reload
```

Open `http://localhost:5199`. No live agent sessions? `?mock=1` plays a scripted
scenario, and `?stress=30` adds 30 characters for a perf check.

## Before you open a PR

```bash
npm --prefix packages/daemon test         # node --test, 241 tests
npm --prefix packages/renderer test       # vitest, 311 tests
npm --prefix packages/renderer run build  # tsc --noEmit && vite build
```

All three must pass. CI runs the same commands on Node 20 and 22, plus
shellcheck over `scripts/*.sh`.

## The leak gate

This repository is public, so a leaked home path, private IP, hostname or token is
permanent. CI runs `node scripts/check-leaks.mjs` (after a `--self-test` that plants
one leak per rule, so a "clean" result is backed by proof the scanner can see). Run it
yourself before pushing. Test fixtures use made-up names (`demo-app`, `/Users/you`).

Names that are sensitive to *you* (a client, a private project) must not be written
into the repo, so they cannot be in the scanner either. Put them, one per line
(`#` comments, `re:<regex>` for a pattern), in `~/.agent-office/leak-denylist.txt`; the
script reads that file when it exists and never prints the term it matched.

To block a bad push locally you can install the optional hook by hand (it is never
installed for you):

```bash
cp scripts/hooks/pre-push "$(git rev-parse --git-path hooks)/pre-push"
chmod +x "$(git rev-parse --git-path hooks)/pre-push"
```

## House style

The existing code is the specification — match the file you are editing rather
than the conventions you would pick yourself.

A few things that are load-bearing here:

- **The daemon is the only writer.** The renderer consumes the event stream and
  never invents state. Keep that direction.
- **Real data over convenient data.** If a number cannot be derived honestly,
  the code says "unknown" rather than guessing. `usage-pricing.js` reports
  tokens without dollars for models with no published price; that is deliberate,
  not an oversight.
- **Test the thing that would actually break.** Several bugs in this repo's
  history passed unit tests and only appeared against the deployed daemon. If a
  change touches process spawning, paths, or the service definition, exercise it
  end to end before claiming it works.
- **Comments explain why, not what.** Explain the non-obvious constraint, the
  trap you fell into, the reason the boring approach was wrong.

## Reporting a bug

Include your OS, your Node version, which agent CLI you are running, and the
daemon log. That is usually enough — the failures here cluster around
environment differences, not logic.

For anything security-related, read [SECURITY.md](SECURITY.md) first.
