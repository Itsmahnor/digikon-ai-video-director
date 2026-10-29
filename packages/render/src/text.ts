// Scene text at the renderer boundary. The approved overlay text is kept exactly as approved; each adapter normalises it here before it checks or draws it.

/** Control characters no renderer can show: everything below space except the line feed, and DEL. A line feed is a legitimate line break. */
const INVALID = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Windows and old Mac line endings become line feeds. Nothing else changes: punctuation, Unicode and intended breaks are kept. */
export const normaliseText = (raw: string): string => raw.replace(/\r\n?/g, "\n");

/** True when the (normalised) text has a character that cannot be drawn: a NUL, a bell, a tab and the like. Line feeds are fine. */
export const hasInvalidControl = (text: string): boolean => INVALID.test(text);

/** Breaks one paragraph at spaces into lines of about `max` characters; a word longer than a line is split. */
function wrapParagraph(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > max) { if (line) { lines.push(line); line = ""; } lines.push(word.slice(0, max)); word = word.slice(max); }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** The conservative line break used to decide whether text fits. Every approved line break starts a new line; each line is wrapped on its own. */
export const wrapText = (text: string, max: number): string[] => normaliseText(text).split("\n").flatMap((p) => wrapParagraph(p, max));
