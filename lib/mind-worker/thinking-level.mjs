/**
 * Pi thinking levels a config may name, weakest to strongest. Pi's package entry
 * does not re-export the ThinkingLevel union, so the extension and both launchers
 * share this list.
 *
 * @typedef {"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} ThinkingLevel
 */

/** @type {readonly ThinkingLevel[]} */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve a configured thinking level.
 * Accepts exactly one of THINKING_LEVELS; anything else (absent, wrong type,
 * misspelled, whitespace-padded) yields the fallback, which may be undefined
 * to mean "leave the choice to Pi".
 *
 * @overload
 * @param {unknown} value configured value
 * @param {ThinkingLevel} fallback value used when the configured one is not a level
 * @returns {ThinkingLevel}
 */
/**
 * @overload
 * @param {unknown} value configured value
 * @param {ThinkingLevel | undefined} fallback value used when the configured one is not a level
 * @returns {ThinkingLevel | undefined}
 */
/**
 * @overload
 * @param {unknown} value configured value
 * @returns {ThinkingLevel | undefined}
 */
/**
 * @param {unknown} value configured value
 * @param {ThinkingLevel} [fallback] value used when the configured one is not a level
 * @returns {ThinkingLevel | undefined}
 */
export function resolveThinkingLevel(value, fallback = undefined) {
	return THINKING_LEVELS.find((level) => level === value) ?? fallback;
}
