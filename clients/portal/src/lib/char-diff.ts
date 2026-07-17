/**
 * Character-level diff summary for experiment / playground compare.
 */
export type CharDiffResult = {
  equal: boolean;
  deltaChars: number;
  commonPrefix: string;
  leftOnly: string;
  rightOnly: string;
  commonSuffix: string;
};

export function charDiff(a: string, b: string, maxChars = 4000): CharDiffResult {
  const left = (a || "").slice(0, maxChars);
  const right = (b || "").slice(0, maxChars);
  if (left === right) {
    return {
      equal: true,
      deltaChars: 0,
      commonPrefix: left,
      leftOnly: "",
      rightOnly: "",
      commonSuffix: "",
    };
  }
  let i = 0;
  while (i < left.length && i < right.length && left[i] === right[i]) i++;
  let j = 0;
  while (
    j < left.length - i &&
    j < right.length - i &&
    left[left.length - 1 - j] === right[right.length - 1 - j]
  ) {
    j++;
  }
  return {
    equal: false,
    deltaChars: Math.abs(left.length - right.length),
    commonPrefix: left.slice(0, i),
    leftOnly: left.slice(i, j ? left.length - j : undefined),
    rightOnly: right.slice(i, j ? right.length - j : undefined),
    commonSuffix: j ? left.slice(left.length - j) : "",
  };
}
