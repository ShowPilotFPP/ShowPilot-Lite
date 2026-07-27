// ============================================================
// Shared SQL identifier guard
// ============================================================
// SQLite can't bind a placeholder for an identifier (table/column name),
// only for a value — so a query that needs a dynamic identifier has no
// prepared-statement parameter to fall back on, and has to splice it into
// the SQL text itself. This is the actual guard against injection for
// that case: every dynamic identifier in this codebase (table names,
// column names built from a hardcoded list or filtered against real
// PRAGMA table_info() output — never directly from request/backup data)
// is checked against this shape before being spliced in, and the SQL
// string it goes into is always built as its own variable first, never a
// template literal or concatenation passed directly as a .prepare()/
// .exec() argument.
function assertIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name;
}

module.exports = { assertIdent };
