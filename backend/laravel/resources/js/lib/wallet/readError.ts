/**
 * Why a read failed, as a code rather than as a sentence.
 *
 * A message thrown down here ends up inside a translated string on screen —
 * "Список токенов получить не удалось: Explorer returned 429" — which is half a
 * dictionary and half an HTTP status, and reads as neither. So the throw
 * carries a message key and the status is appended after a colon: the screen
 * translates the first half and prints the second small, because the number is
 * what an operator reads off a screenshot and the sentence is what the person
 * holding the phone needs.
 *
 * Anything this module did not produce passes through untouched: a network
 * error from `fetch` has no code of ours, and inventing one for it would be the
 * same lie in the other direction.
 */

/** The explorer answered, and the answer was a refusal. */
export const explorerFailure = (status: number): Error =>
    new Error(
        `${status === 429 ? 'readRateLimited' : 'readUnavailable'}:${status}`,
    );

const KEYS = new Set(['readRateLimited', 'readUnavailable']);

/**
 * Splits a thrown message into the part a dictionary owns and the part it does
 * not. `code` is null for anything that was never one of ours.
 */
export const readErrorParts = (
    message: string,
): { code: string | null; detail: string } => {
    const at = message.indexOf(':');
    const code = at === -1 ? message : message.slice(0, at);

    return KEYS.has(code)
        ? { code, detail: at === -1 ? '' : message.slice(at + 1) }
        : { code: null, detail: message };
};

/**
 * The sentence to show for a failed read: translated where the code is one of
 * ours, and the raw message where it is not. The status, when there is one,
 * comes back separately so a screen can print it quieter than the sentence.
 */
export const describeReadError = (
    message: string,
    t: (key: string) => string,
): { text: string; detail: string } => {
    const { code, detail } = readErrorParts(message);

    return code === null
        ? { text: detail, detail: '' }
        : { text: t(code), detail };
};
