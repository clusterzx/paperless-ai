/**
 * Patterns that users write (workflow conditions) and that run on text of any length: a regular
 * expression like /(a+)+$/ can take hours on a few dozen characters and would block the server for
 * everyone. Regular expressions run with a time limit; file name patterns (* and ?) are matched
 * without backtracking.
 */
import vm from 'node:vm';

const REGEX_TIMEOUT_MS = 500;
const test = new vm.Script('re.test(text)');

/** `re.test(text)`, but at most REGEX_TIMEOUT_MS long (then it throws). */
export function regexTest(re: RegExp, text: string, timeoutMs = REGEX_TIMEOUT_MS): boolean {
  re.lastIndex = 0;
  try {
    return test.runInNewContext({ re, text }, { timeout: timeoutMs }) === true;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT')
      throw new Error(`The regular expression took longer than ${timeoutMs} ms on this text – make it simpler`, { cause: err });
    throw err;
  }
}

/**
 * Whether `name` matches the file name pattern (`*` any characters, `?` one character, case does
 * not matter). Linear in practice, never exponential: a `*` only goes back to the last `*`.
 */
export function globMatch(pattern: string, name: string): boolean {
  const p = [...pattern.toLowerCase()];
  const s = [...name.toLowerCase()];
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < s.length) {
    if (i < p.length && (p[i] === '?' || (p[i] !== '*' && p[i] === s[j]))) {
      i++;
      j++;
    } else if (i < p.length && p[i] === '*') {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}
