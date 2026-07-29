// Friendly agent names: replace the random worktree codename (e.g.
// "confident-archimedes-9f9205" — Claude's random worktree folder) with a
// readable role + sequence, e.g. "coder-01". Agents don't carry an explicit
// role yet, so the role is inferred from the repo/office name; coding is the
// default since most agent work is code. Pure — the reducer assigns the name
// once at spawn (stable thereafter). The raw worktree path stays in `cwd`.

/** repo/office name → role word. First match wins; order = most specific first. */
const ROLE_KEYWORDS: readonly (readonly [RegExp, string])[] = [
  [/market|\bads?\b|campaign|seo|social/i, "marketing"],
  [/content|blog|writ|copy|article|studio/i, "content"],
  [/plan|strateg|roadmap|\bpm\b/i, "planner"],
  [/design|\bui\b|\bux\b|brand|figma/i, "designer"],
];

/**
 * Role word for an agent: its explicit role if set (slugified), else inferred
 * from the repo/office name, else "coder". Pure.
 */
export function roleOf(repo: string, role: string | null): string {
  if (role) {
    const slug = role.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || "agent";
  }
  for (const [re, word] of ROLE_KEYWORDS) if (re.test(repo)) return word;
  return "coder";
}

/** "coder-03" — role + zero-padded 1-based sequence. Pure. */
export function friendlyName(role: string, index: number): string {
  return `${role}-${String(index).padStart(2, "0")}`;
}
