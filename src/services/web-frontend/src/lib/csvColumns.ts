/**
 * The column names the mapping UI offers for a *pasted* cap table.
 *
 * The upload path does not come through here: a file is posted, the valuation
 * service parses it with `parseCsvSheet`, and the headers it returns are what
 * the dropdowns list. The paste path has no round trip — the raw text sits in a
 * textarea, the mapping is chosen against columns the browser worked out, and
 * only then is the text sent to be parsed by the server. So the browser and the
 * server each name the columns, independently, and the mapping is keyed by
 * name. Anything they disagree about is a column the user can select and the
 * server cannot find.
 *
 * They disagreed about three things, and each one is a file people actually
 * have:
 *
 *   - **The delimiter.** Excel writes the locale's list separator, so "Save as
 *     CSV" in most of continental Europe is semicolon-delimited, and a paste
 *     straight out of a spreadsheet is tab-delimited. The server sniffs; the
 *     browser assumed a comma, so the whole header line came back as a single
 *     column called `Security Class;Units;Price`. Every column in the file was
 *     unmappable, on a file the importer handles perfectly.
 *   - **The BOM.** "CSV UTF-8" from Excel — and every CSV this platform itself
 *     exports — begins with U+FEFF. The server strips it; the browser kept it,
 *     so the first column, which is almost always the security class, was
 *     offered under a name with an invisible character on the front that the
 *     server's lookup could not match.
 *   - **Repeated names.** Two columns called "Shares" are named `Shares` and
 *     `Shares (2)` by the server. The browser listed `Shares` twice, and both
 *     entries mapped to the first one, so the second column could not be
 *     reached at all.
 *
 * This file is the browser's half written to the server's rules. It is a
 * deliberate duplicate: `domain/capTable.ts` lives in a Node service that
 * imports `pg`, and there is no shared package the browser bundle can reach it
 * through. If the server's parsing rules change, they change here too — the
 * test names the fixtures both halves have to agree on.
 */

/** Field separators worth guessing between, in tie-break order. Mirrors DELIMITERS. */
const DELIMITERS = [',', ';', '\t'] as const;

/**
 * Guess the field separator from the first physical line — the server's
 * `sniffDelimiter`, including its choice to look at the line rather than the
 * first logical record. Separators inside quotes do not vote, so a quoted
 * company name with a comma in it cannot outvote the real delimiter.
 */
function sniffDelimiter(text: string): string {
  const end = text.search(/[\r\n]/);
  const header = end === -1 ? text : text.slice(0, end);

  let best: string = DELIMITERS[0];
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < header.length; i++) {
      const c = header[i];
      if (c === '"') {
        if (inQuotes && header[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && c === delimiter) count++;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

/** The first record with anything in it, split on `delimiter`, quotes honoured. */
function firstRecord(body: string, delimiter: string): string[] | null {
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const finish = (): string[] | null => {
    row.push(field);
    const done = row.some((f) => f.trim() !== '') ? row : null;
    field = '';
    row = [];
    return done;
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      // A newline inside a quoted field never reaches here, so a header cell
      // that legitimately spans two lines stays one cell.
      if (c === '\r' && body[i + 1] === '\n') i++;
      const done = finish();
      if (done) return done;
    } else field += c;
  }
  return field !== '' || row.length > 0 ? finish() : null;
}

/**
 * Column names in source order, blanks dropped and repeats disambiguated —
 * the server's `nameColumns` followed by its `headers` filter.
 */
export function csvColumns(text: string): string[] {
  const body = text.replace(/^\uFEFF/, '');
  const cells = firstRecord(body, sniffDelimiter(body));
  if (!cells) return [];
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const cell of cells) {
    const name = cell.trim();
    if (name === '') continue;
    const priorUses = seen.get(name) ?? 0;
    seen.set(name, priorUses + 1);
    out.push(priorUses === 0 ? name : `${name} (${priorUses + 1})`);
  }
  return out;
}
