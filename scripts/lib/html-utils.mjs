// Small shared helpers for safely reading const-object/array literals
// out of index.html without a full JS parser dependency.

// Finds the matching closing brace/bracket for a literal that starts at
// `openIdx` (the index of its opening `{` or `[`), by depth-counting —
// robust regardless of what code/comments follow it in the file.
export function findMatchingBrace(html, openIdx) {
  const openChar = html[openIdx];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  for (let i = openIdx; i < html.length; i++) {
    if (html[i] === openChar) depth++;
    else if (html[i] === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Parses `const <name> = { ... };` (or `= [ ... ];`) out of index.html by
// depth-counting to find the real end, then evaluating the literal as JS.
// Trusted, self-authored content — not third-party input — so this is
// safe. Returns { value, openIdx, closeIdx } or null if not found.
export function parseNamedLiteral(html, name) {
  const keyword = `const ${name} = `;
  const start = html.indexOf(keyword);
  if (start === -1) return null;
  const openIdx = start + keyword.length; // points at { or [
  const closeIdx = findMatchingBrace(html, openIdx);
  if (closeIdx === -1) return null;
  const value = new Function(`return ${html.slice(openIdx, closeIdx + 1)}`)();
  return { value, openIdx, closeIdx };
}
