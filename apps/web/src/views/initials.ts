/**
 * Monogram of a name — what the round avatar of a member row shows.
 *
 * One function, because there were two with two behaviours: the row of
 * *Nutzerrechte je Formular* split on a single space (so „Anna  Admin" produced
 * „A" and a doubled space produced nothing), the tenant member row split on any
 * run of whitespace and fell back to „?". Two answers to „what does this name
 * look like in a circle" is one too many, and the difference only ever shows up
 * on the names nobody tests with.
 *
 * Decorative: every place that draws it marks the element `aria-hidden`, and the
 * full name stands next to it.
 */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '')
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase());
  return letters.join('') || '?';
}
