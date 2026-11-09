/** Quotes a path for a shell prompt; plain paths stay as they are. */
export const shellQuote = (p: string) =>
  /^[\w./@%+=:,-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
