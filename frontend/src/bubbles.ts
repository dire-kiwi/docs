/**
 * Where comment bubbles go in the margin: each as close to its quote's line as
 * it can be without overlapping the others. The active bubble sits right at its
 * quote, pushing the ones above it up and the ones below it down.
 *
 * `anchors` are the wanted tops, in order (NaN for a comment whose quote is no
 * longer in the page: it goes after the others); returns the tops to use.
 */
export function layoutBubbles(
  anchors: number[],
  heights: number[],
  active = -1,
  gap = 8,
): number[] {
  const tops: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const below = i === 0 ? 0 : tops[i - 1] + heights[i - 1] + gap;
    const want = Number.isNaN(anchors[i]) ? below : anchors[i];
    tops.push(i === 0 || i === active ? want : Math.max(want, below));
  }
  for (let i = active - 1; i >= 0; i--) {
    tops[i] = Math.min(tops[i], tops[i + 1] - gap - heights[i]);
  }
  return tops;
}
