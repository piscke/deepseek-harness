/**
 * One shared rendering of a thrown value for process-local diagnostics.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/diagnostics
 */

/**
 * Render an unknown thrown value as text for a log line.
 * @param value - the caught value, which a rejected promise may make anything.
 * @returns the error's message, or the value stringified.
 */
export function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
