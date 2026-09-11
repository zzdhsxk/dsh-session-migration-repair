/**
 * Line handling for a stored DSH session log.
 * @module dsh-session-migration-repair/core/log
 */

/**
 * Split decompressed log text into lines and parsed rows.
 * Unparsable lines are reported instead of throwing, so a damaged log can still
 * be inspected.
 * @param {string} text
 */
export function parseLog(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = new Array(lines.length);
  const invalid = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") { rows[index] = undefined; continue; }
    try {
      rows[index] = JSON.parse(line);
    } catch (error) {
      rows[index] = undefined;
      invalid.push({ line: index + 1, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { lines, rows, invalid };
}

/** Join lines back into log text (single trailing newline). */
export function serializeLog(lines) {
  return lines.join("\n") + "\n";
}

/** Pull `data.message.content` blocks out of a message-shaped event. */
export function messageContent(row) {
  const content = row?.data?.message?.content;
  return Array.isArray(content) ? content : undefined;
}
