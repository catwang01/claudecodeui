/**
 * Project exclude-pattern matching shared by the browser client and the Node
 * server. This module is the single source of truth for the semantics used by
 * the sidebar filter (filterProjects), the project scan in server/projects.js,
 * the Claude session synchronizer and conversation search.
 *
 * A pattern is a case-insensitive JavaScript regular expression tested against
 * BOTH the full path and its trailing path segment (the directory name), so an
 * anchored pattern such as '^agent.*' can exclude a directory named
 * 'agent-xx'. Full-path matching is preserved so existing substring patterns keep
 * working; blank and invalid patterns are ignored, and this function never throws.
 *
 * Note: this module ships to the browser (vite) and is compiled by the server
 * build, so keep it dependency-free and side-effect-free.
 */
export function matchesExcludePattern(target: unknown, patterns: unknown): boolean {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;

  const targetPath = typeof target === 'string' ? target : '';
  // Windows and POSIX separators both count; a trailing separator must not
  // produce an empty basename.
  const trailingSegment = targetPath.replace(/[\\/]+$/, '').split(/[\\/]+/).pop() || '';

  return patterns.some((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim() === '') return false;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      return false;
    }

    return regex.test(targetPath) || (trailingSegment !== '' && regex.test(trailingSegment));
  });
}
