/**
 * Restriction of instance-wide lists (history, statistics, problems, OCR) to the documents of some
 * libraries of the built-in archive. `null`/undefined = no restriction: companion mode (one shared
 * view) and unrestricted scopes. Filters are part of the SQL, never applied to results afterwards
 * (docs/standalone/access-control.md §4).
 */

/** `column IN (documents of the libraries)`; takes one parameter: the library ids as JSON. */
export function inLibraries(column: string, param = '?'): string {
  return `${column} IN (SELECT id FROM lib_documents WHERE library_id IN (SELECT value FROM json_each(${param})))`;
}

/** ` AND …` condition and its parameters for an optional library restriction. */
export function libsCond(column: string, libs: number[] | null | undefined): { sql: string; params: string[] } {
  return libs ? { sql: ` AND ${inLibraries(column)}`, params: [JSON.stringify(libs)] } : { sql: '', params: [] };
}
