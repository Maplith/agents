import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ENVELOPE, MAX_REPLY, jsonStringBytes } from './serve.ts';

/** The PostgreSQL extractor of Maplith Bridge.
 *
 *  It runs in the network that holds the database, next to the server
 *  (serve.ts), under a read-only login role the database's owner creates. It
 *  reads the catalog and the tables that role may read, and writes one CSV
 *  per table into the folder the server shares. No client of the server ever
 *  holds the database credential: the password stays on this machine, and
 *  what a client reads is the folder, exactly as if someone had exported it
 *  by hand.
 *
 *  What it reads, every statement a fixed template in this file:
 *   1. the catalog: schemas, tables, views and materialized views, their
 *      columns with declared types, and declared primary, unique and foreign
 *      keys — from pg_catalog, with the same visibility information_schema
 *      gives (only columns the role may SELECT), because information_schema
 *      leaves out materialized views and shows constraints only to a role
 *      with more than SELECT on the table;
 *   2. row counts from the catalog (pg_class.reltuples, an estimate), never
 *      by counting;
 *   3. column statistics as counts only: pg_stats.null_frac and n_distinct.
 *      Never most_common_vals or histogram_bounds — they are lists of values;
 *   4. the contents, one CSV per table, in a deterministic order and cut to
 *      what the template can serve (see writeTable).
 *
 *  What it never does, and where that is enforced:
 *   - write: the run refuses to start under a role that holds any privilege
 *     beyond reading (checkRole), and runs in one READ ONLY transaction with
 *     default_transaction_read_only on as a second belt;
 *   - run SQL it did not write: no option takes SQL; table and column names
 *     come only from the catalog and are quoted (quoteIdent);
 *   - put a cell value anywhere but the table's own CSV: the catalog file,
 *     the log lines and the error texts carry names and counts only;
 *   - run unbounded: a statement_timeout on every statement, a deadline for
 *     the run, and a row and byte cap per table;
 *   - read outside the grant: it reads what the role may read, and the role
 *     may not be a member of any predefined role (pg_read_all_data and the
 *     like) — what is read is narrowed by grants, never by SQL.
 *
 *  It runs on Node.js 24 or newer as it is (`node extract-postgres.ts`), with
 *  one package beside it: the PostgreSQL client `pg` (node-postgres), loaded
 *  only by the command line entry. The module itself takes a query function,
 *  so it is tested against an in-process PostgreSQL (PGlite) with no server
 *  (test/extract-postgres.test.ts). */

/** Runs one statement with its parameters and returns the rows as objects. */
export type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface ExtractOptions {
  query: Query;
  /** The folder the template serves. */
  out: string;
  /** Put every table under one system folder, as `<system>/<schema>.<table>.csv`.
   *  Without it the schema is the system: `<schema>/<table>.csv`. */
  system?: string;
  /** Rows per table at most. Default {@link DEFAULT_MAX_ROWS}. */
  maxRows?: number;
  /** Bytes per file, counted as the template counts its reply. Default and
   *  maximum: what the template will serve ({@link MAX_FILE_BYTES}). */
  maxBytes?: number;
  /** Per statement, in milliseconds. Default five minutes. */
  statementTimeoutMs?: number;
  /** For the whole run, in milliseconds. Default one hour. */
  deadlineMs?: number;
  /** Verify the role and read the catalog, but write nothing. */
  checkOnly?: boolean;
  /** One line per table and per decision. Never given a cell value. */
  log?: (line: string) => void;
  /** For tests: the clock the deadline is measured on. */
  now?: () => number;
}

/** A table larger than this is cut, in its deterministic order. Most tables
 *  meet the byte cap first: the template serves a file only when its reply
 *  fits in 8 MB (serve.ts MAX_REPLY). */
export const DEFAULT_MAX_ROWS = 50_000;
/** What serve.ts lists: the reply, JSON escaping included, under MAX_REPLY
 *  with room for the envelope. One more kilobyte of room for the cut line. */
export const MAX_FILE_BYTES = MAX_REPLY - ENVELOPE - 1024;
/** The hidden file the extractor keeps beside what it writes: the catalog it
 *  read and the files it wrote. The server never serves a hidden file, so
 *  no client reads it. */
export const CATALOG_FILE = '.maplith-extract.json';
export const CATALOG_FORMAT = 'maplith-extract/1';

/** A role the extractor will not run under. `reasons` name roles and objects,
 *  never a value. */
/** A name from the database as one line of plain text: control characters
 *  (a terminal escape, a line break) become `?`, and a long name is cut. The
 *  names come from whoever may create objects in the database, and the lines
 *  are read by a person, or by an agent, at a terminal. */
export function printable(name: string): string {
  const flat = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

const DEFAULT_ACL_KINDS: Record<string, string> = { r: 'table', S: 'sequence', f: 'function', T: 'type', n: 'schema', L: 'large object' };

export class RefusedError extends Error {
  reasons: Finding[];
  constructor(reasons: Finding[]) {
    const shown = reasons.slice(0, 20).map((r) => `  - ${printable(describe(r))}`);
    const more = reasons.length > shown.length ? [`  - and ${reasons.length - shown.length} more`] : [];
    super(
      [
        'Refusing to run: the role can do more than read. Use a login role that is granted SELECT and nothing else (see the guide at maplith.com/docs/mcp-template).',
        ...shown,
        ...more,
      ].join('\n'),
    );
    this.name = 'RefusedError';
    this.reasons = reasons;
  }
}

export interface Finding {
  kind: string;
  role: string;
  object: string | null;
}

function describe(f: Finding): string {
  switch (f.kind) {
    case 'login':
      return `the session logged in as ${f.role} and switched to ${f.object}: log in as the read-only role itself`;
    case 'attribute':
      return `${f.role} has the attribute ${f.object}`;
    case 'predefined role':
      return `the role is a member of ${f.object}`;
    case 'relation':
      return `${f.role} may change ${f.object} (a privilege beyond SELECT)`;
    case 'sequence':
      return `${f.role} may advance or set the sequence ${f.object}`;
    case 'owner':
      return `${f.role} owns ${f.object}`;
    case 'schema':
      return `${f.role} may create objects in, or owns, the schema ${f.object} (on PostgreSQL 14 or older: REVOKE CREATE ON SCHEMA public FROM PUBLIC)`;
    case 'database':
      return `${f.role} may create schemas in, or owns, the database ${f.object}`;
    case 'large object':
      return `${f.role} may write the ${f.object} (UPDATE in its access list)`;
    case 'setting':
      return `${f.object} is on: every role may write every large object`;
    case 'function':
      return `${f.role} may run the ${f.object} with its owner's rights (SECURITY DEFINER)`;
    case 'grant option':
      return `${f.role} may grant ${f.object} to other roles (WITH GRANT OPTION)`;
    case 'parameter':
      return `${f.role} may change the server parameter ${f.object} (GRANT SET or ALTER SYSTEM ON PARAMETER)`;
    case 'admin option':
      return `${f.role} may add other roles to ${f.object} (WITH ADMIN OPTION)`;
    case 'default privilege':
      return `${f.role} would be granted more than reading on every new ${DEFAULT_ACL_KINDS[f.object ?? ''] ?? 'object'} (ALTER DEFAULT PRIVILEGES)`;
    case 'foreign data wrapper':
      return `${f.role} may use the foreign-data wrapper ${f.object} (it could define a connection to another server)`;
    case 'foreign server':
      return `${f.role} may use the foreign server ${f.object} (it could create its own user mapping and reach another server)`;
    case 'transaction':
      return 'the transaction is not read-only';
    default:
      return `${f.kind}: ${f.role} ${f.object ?? ''}`.trim();
  }
}

/** A double-quoted identifier, as the driver's identifier quoting does it
 *  (node-postgres escapeIdentifier). Never interpolated otherwise. */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new Error('An identifier with a NUL character');
  return `"${name.replace(/"/g, '""')}"`;
}

// --- The fixed statements ---------------------------------------------------

/** Every statement the extractor sends that is not a table's contents query.
 *  The contents query (contentsSql) is assembled from catalog names only.
 *
 *  Every setting a value's text form depends on is fixed here, so the files
 *  do not move with the defaults of the role, the database or the client
 *  (PGOPTIONS, PGTZ): the time zone, the date and interval styles, float
 *  precision, bytea's form, and lc_monetary, which writes a money value with
 *  the locale's symbol and separators ("C" is on every server). */
export const SESSION_SQL = [
  'SET default_transaction_read_only = on',
  "SET search_path = 'pg_catalog'",
  "SET TimeZone = 'UTC'",
  "SET DateStyle = 'ISO, YMD'",
  "SET IntervalStyle = 'postgres'",
  'SET extra_float_digits = 1',
  "SET bytea_output = 'hex'",
  "SET lc_monetary = 'C'",
] as const;
export const TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, false) AS statement_timeout";
export const BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
export const END_SQL = 'ROLLBACK';
export const SESSION_INFO_SQL =
  "SELECT current_setting('transaction_read_only') AS read_only, current_setting('server_version_num') AS version, current_database()::text AS database";

/** Every way the role (and every role it is a member of, inherited or not)
 *  could change something. One row per finding; none means read-only.
 *  `has_*_privilege` counts grants to PUBLIC, ownership and membership.
 *  pg_catalog.pg_settings is the one relation left out: every PostgreSQL
 *  grants UPDATE on it to PUBLIC, and an UPDATE there is SET — a setting of
 *  the session's own, like the ones this extractor sets itself.
 *  TEMPORARY on a database is deliberately not a finding: PostgreSQL grants
 *  it to PUBLIC by default, a temporary table is private to the session and
 *  gone when it ends, and the extractor never creates one.
 *
 *  Three more ways to write:
 *   - a large object's access list granting UPDATE to the role or to PUBLIC
 *     (read from pg_largeobject_metadata.lomacl on every version, because
 *     has_largeobject_privilege exists only from PostgreSQL 17), and
 *     lo_compat_privileges, which turns those checks off for every role;
 *   - EXECUTE granted to the role (or a role it is a member of) on any
 *     SECURITY DEFINER function: it runs with its owner's rights, whatever
 *     its volatility. (A STABLE one is not read-only: it may call a VOLATILE
 *     function that writes.) The same reach through PUBLIC is a warning, not
 *     a refusal (WARNINGS_SQL);
 *   - USAGE on a foreign-data wrapper or a foreign server: with it a role can
 *     define a server or its own user mapping, a write to the catalog, and
 *     reach another database. Foreign tables themselves are never read
 *     (TABLES_SQL) and a write privilege on one is refused above.
 *
 *  A default privilege (ALTER DEFAULT PRIVILEGES) that would grant the role
 *  more than reading on objects created later is refused now, not when the
 *  first such table appears.
 *
 *  And the ways a role could hand out or change access
 *  rather than data:
 *   - a grant option (WITH GRANT OPTION) on a table, view or column, a
 *     sequence, a schema, a database, a function, a type or a large object:
 *     the role could grant what it reads to another role;
 *   - the admin option on a membership (WITH ADMIN OPTION): the role could
 *     add other roles to that group;
 *   - owning a catalog object beyond relations, functions, types and large
 *     objects: a publication, a subscription, an extension, a language, an
 *     operator, an operator class or family, a collation, a conversion, a
 *     text search configuration or dictionary, an extended statistics
 *     object, an event trigger or a tablespace. */
export function roleCheckSql(serverVersion: number): string {
  const tablePrivileges = serverVersion >= 170000 ? 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN' : 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER';
  // PostgreSQL 15 added grants on server parameters (pg_parameter_acl): SET on
  // a superuser-only setting, or ALTER SYSTEM, which writes the server's
  // configuration file. Older versions have neither.
  const parameterGrants =
    serverVersion >= 150000
      ? `
UNION ALL
SELECT 'parameter', m.role, p.parname::text FROM me m CROSS JOIN pg_parameter_acl p
  WHERE EXISTS (SELECT 1 FROM aclexplode(p.paracl) a WHERE a.privilege_type IN ('SET', 'ALTER SYSTEM') AND a.grantee IN (m.oid, 0))`
      : '';
  return `WITH me AS (
  SELECT r.oid, r.rolname::text AS role, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication
  FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER')
)
SELECT 'login' AS kind, session_user::text AS role, current_user::text AS object WHERE session_user <> current_user
UNION ALL
SELECT 'attribute', m.role, a.attr FROM me m
  CROSS JOIN LATERAL (VALUES ('SUPERUSER', m.rolsuper), ('CREATEROLE', m.rolcreaterole), ('CREATEDB', m.rolcreatedb),
    ('BYPASSRLS', m.rolbypassrls), ('REPLICATION', m.rolreplication)) AS a(attr, held)
  WHERE a.held
UNION ALL
SELECT 'predefined role', current_user::text, m.role FROM me m WHERE m.role LIKE 'pg\\_%'
UNION ALL
SELECT 'relation', m.role, format('%I.%I', n.nspname, c.relname) FROM me m CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.oid <> 'pg_catalog.pg_settings'::regclass
    AND (has_table_privilege(m.oid, c.oid, '${tablePrivileges}') OR has_any_column_privilege(m.oid, c.oid, 'INSERT, UPDATE, REFERENCES'))
UNION ALL
SELECT 'sequence', m.role, format('%I.%I', n.nspname, c.relname) FROM me m CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S' AND has_sequence_privilege(m.oid, c.oid, 'USAGE, UPDATE')
UNION ALL
SELECT 'owner', m.role, format('%I.%I', n.nspname, c.relname) FROM me m JOIN pg_class c ON c.relowner = m.oid JOIN pg_namespace n ON n.oid = c.relnamespace
UNION ALL
SELECT 'owner', m.role, 'function ' || p.oid::regprocedure::text FROM me m JOIN pg_proc p ON p.proowner = m.oid
UNION ALL
SELECT 'owner', m.role, 'type ' || t.oid::regtype::text FROM me m JOIN pg_type t ON t.typowner = m.oid
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid)
UNION ALL
SELECT 'owner', m.role, 'large object ' || l.oid::text FROM me m JOIN pg_largeobject_metadata l ON l.lomowner = m.oid
UNION ALL
SELECT 'large object', m.role, 'large object ' || l.oid::text FROM me m CROSS JOIN pg_largeobject_metadata l
  WHERE l.lomowner <> m.oid AND EXISTS (SELECT 1 FROM aclexplode(l.lomacl) a WHERE a.privilege_type = 'UPDATE' AND a.grantee IN (m.oid, 0))
UNION ALL
SELECT 'setting', current_user::text, 'lo_compat_privileges' WHERE current_setting('lo_compat_privileges') = 'on'
UNION ALL
SELECT 'function', m.role, 'function ' || p.oid::regprocedure::text FROM me m CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosecdef AND p.proowner <> m.oid AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee = m.oid)
UNION ALL
SELECT 'grant option', m.role, 'SELECT on ' || format('%I.%I', n.nspname, c.relname) FROM me m CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND c.relowner <> m.oid
    AND (has_table_privilege(m.oid, c.oid, 'SELECT WITH GRANT OPTION') OR has_any_column_privilege(m.oid, c.oid, 'SELECT WITH GRANT OPTION'))
UNION ALL
SELECT 'grant option', m.role, 'SELECT on the sequence ' || format('%I.%I', n.nspname, c.relname) FROM me m CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'S' AND c.relowner <> m.oid AND has_sequence_privilege(m.oid, c.oid, 'SELECT WITH GRANT OPTION')
UNION ALL
SELECT 'grant option', m.role, 'USAGE on the schema ' || quote_ident(n.nspname) FROM me m CROSS JOIN pg_namespace n
  WHERE n.nspowner <> m.oid AND has_schema_privilege(m.oid, n.oid, 'USAGE WITH GRANT OPTION')
UNION ALL
SELECT 'grant option', m.role, 'CONNECT or TEMPORARY on the database ' || quote_ident(d.datname) FROM me m CROSS JOIN pg_database d
  WHERE d.datdba <> m.oid AND has_database_privilege(m.oid, d.oid, 'CONNECT WITH GRANT OPTION, TEMPORARY WITH GRANT OPTION')
UNION ALL
SELECT 'grant option', m.role, 'EXECUTE on the function ' || p.oid::regprocedure::text FROM me m CROSS JOIN pg_proc p
  WHERE p.proowner <> m.oid AND has_function_privilege(m.oid, p.oid, 'EXECUTE WITH GRANT OPTION')
UNION ALL
SELECT 'grant option', m.role, 'USAGE on the type ' || t.oid::regtype::text FROM me m CROSS JOIN pg_type t
  WHERE t.typowner <> m.oid AND has_type_privilege(m.oid, t.oid, 'USAGE WITH GRANT OPTION')
UNION ALL
SELECT 'grant option', m.role, 'SELECT on the large object ' || l.oid::text FROM me m CROSS JOIN pg_largeobject_metadata l
  WHERE l.lomowner <> m.oid AND EXISTS (SELECT 1 FROM aclexplode(l.lomacl) a WHERE a.is_grantable AND a.grantee = m.oid)
UNION ALL
SELECT 'admin option', m.role, r.rolname::text FROM pg_auth_members am JOIN me m ON m.oid = am.member JOIN pg_roles r ON r.oid = am.roleid
  WHERE am.admin_option
UNION ALL
SELECT 'owner', m.role, o.what FROM me m JOIN (
  SELECT pubowner AS owner, 'publication ' || quote_ident(pubname) AS what FROM pg_publication
  UNION ALL SELECT subowner, 'subscription ' || quote_ident(subname) FROM pg_subscription
  UNION ALL SELECT extowner, 'extension ' || quote_ident(extname) FROM pg_extension
  UNION ALL SELECT lanowner, 'language ' || quote_ident(lanname) FROM pg_language
  UNION ALL SELECT oprowner, 'operator ' || oid::regoperator::text FROM pg_operator
  UNION ALL SELECT opcowner, 'operator class ' || quote_ident(opcname) FROM pg_opclass
  UNION ALL SELECT opfowner, 'operator family ' || quote_ident(opfname) FROM pg_opfamily
  UNION ALL SELECT collowner, 'collation ' || quote_ident(collname) FROM pg_collation
  UNION ALL SELECT conowner, 'conversion ' || quote_ident(conname) FROM pg_conversion
  UNION ALL SELECT cfgowner, 'text search configuration ' || quote_ident(cfgname) FROM pg_ts_config
  UNION ALL SELECT dictowner, 'text search dictionary ' || quote_ident(dictname) FROM pg_ts_dict
  UNION ALL SELECT stxowner, 'statistics object ' || quote_ident(stxname) FROM pg_statistic_ext
  UNION ALL SELECT evtowner, 'event trigger ' || quote_ident(evtname) FROM pg_event_trigger
  UNION ALL SELECT spcowner, 'tablespace ' || quote_ident(spcname) FROM pg_tablespace
) o ON o.owner = m.oid
UNION ALL
SELECT 'default privilege', m.role, d.defaclobjtype::text FROM me m CROSS JOIN pg_default_acl d
  WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee IN (m.oid, 0)
    AND (a.is_grantable OR a.privilege_type NOT IN ('SELECT', 'USAGE', 'EXECUTE')))
UNION ALL
SELECT 'foreign data wrapper', m.role, w.fdwname::text FROM me m CROSS JOIN pg_foreign_data_wrapper w
  WHERE has_foreign_data_wrapper_privilege(m.oid, w.oid, 'USAGE')
UNION ALL
SELECT 'foreign server', m.role, s.srvname::text FROM me m CROSS JOIN pg_foreign_server s
  WHERE has_server_privilege(m.oid, s.oid, 'USAGE')
UNION ALL
SELECT 'schema', m.role, n.nspname::text FROM me m CROSS JOIN pg_namespace n
  WHERE has_schema_privilege(m.oid, n.oid, 'CREATE') OR n.nspowner = m.oid
UNION ALL
SELECT 'database', m.role, d.datname::text FROM me m CROSS JOIN pg_database d
  WHERE has_database_privilege(m.oid, d.oid, 'CREATE') OR d.datdba = m.oid${parameterGrants}
ORDER BY 1, 2, 3`;
}

/** What every role in the database may do, this one included, that a
 *  read-only role cannot be told apart from: a SECURITY DEFINER function, of
 *  any volatility, anyone may run, because EXECUTE on a function goes to
 *  PUBLIC unless revoked. A warning, not a refusal: no grant to
 *  this role could be revoked to clear it — only a REVOKE … FROM PUBLIC that
 *  changes every role, which may break the applications that call it — and
 *  the extractor never calls a function of the database's own, inside a
 *  transaction that is read-only, where a function's writes fail too. Only
 *  functions in a schema the role may use: one it cannot reach is no reach. */
export const WARNINGS_SQL = `SELECT 'function' AS kind, 'PUBLIC' AS role, 'function ' || p.oid::regprocedure::text AS object
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND has_schema_privilege(n.oid, 'USAGE')
  AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0))
ORDER BY 3`;

/** Foreign tables the role may read, which the extractor leaves out on
 *  purpose: a read there runs on another server, under a user mapping, so it
 *  is a different system with its own owner. Named in the log so a missing
 *  file is never a mystery. */
export const FOREIGN_TABLES_SQL = `SELECT format('%I.%I', n.nspname, c.relname) AS name
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'f' AND has_schema_privilege(n.oid, 'USAGE') AND has_any_column_privilege(c.oid, 'SELECT')
ORDER BY 1`;

/** Tables, views and materialized views the role may read at least one column
 *  of. Partitions are read through their parent; foreign tables are not read
 *  (a read there runs on another server). System schemas are left out. */
export const TABLES_SQL = `SELECT c.oid::text AS oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS kind,
  CASE WHEN c.relkind IN ('r', 'p', 'm') AND c.reltuples >= 0 THEN c.reltuples::float8 END AS estimated_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'v', 'm') AND NOT c.relispartition
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
  AND has_schema_privilege(n.oid, 'USAGE') AND has_any_column_privilege(c.oid, 'SELECT')
ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"`;

/** The columns the role may SELECT, with their declared types. */
export const COLUMNS_SQL = `SELECT a.attrelid::text AS oid, a.attname::text AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
FROM pg_attribute a
WHERE a.attrelid = ANY($1::text[]::oid[]) AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(a.attrelid, a.attnum, 'SELECT')
ORDER BY a.attrelid, a.attnum`;

/** Declared primary, unique and foreign keys, by column name. */
export const KEYS_SQL = `SELECT k.conrelid::text AS oid, k.contype::text AS type, k.conname::text AS name,
  ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY AS u(n, i) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.i) AS columns,
  k.confrelid::text AS ref_oid,
  ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY AS u(n, i) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.i) AS ref_columns
FROM pg_constraint k
WHERE k.conrelid = ANY($1::text[]::oid[]) AND k.contype IN ('p', 'u', 'f')
ORDER BY k.conrelid, k.contype, k.conname COLLATE "C"`;

/** Counts only: the share of nulls and the number of distinct values. The
 *  view's value lists (most_common_vals, histogram_bounds) are never selected. */
export const STATS_SQL = `SELECT s.attname::text AS name, s.null_frac::float8 AS null_frac, s.n_distinct::float8 AS n_distinct
FROM pg_stats s WHERE s.schemaname = $1 AND s.tablename = $2
ORDER BY s.attname COLLATE "C", s.inherited`;

/** A table's contents: the readable columns as PostgreSQL prints them (the
 *  type's output function, as COPY writes them), NULL kept apart from an empty
 *  string, in a total order — the primary key, or every column when there is
 *  none — and one row more than the cap, to know whether it was cut.
 *  The ORDER BY names the table's own columns through its alias `t`: a bare
 *  name there would mean an output column first, and a table with a column
 *  named c0 or c1 would be sorted by the wrong one. */
export function contentsSql(schema: string, table: string, columns: readonly string[], primaryKey: readonly string[] | null): string {
  const cols = columns.map((c, i) => `CASE WHEN t.${quoteIdent(c)} IS NULL THEN NULL ELSE format('%s', t.${quoteIdent(c)}) END AS c${i}`);
  const order = primaryKey
    ? primaryKey.map((c) => `t.${quoteIdent(c)}`)
    : columns.flatMap((c) => [`(t.${quoteIdent(c)} IS NULL)`, `format('%s', t.${quoteIdent(c)}) COLLATE "C"`]);
  return `SELECT ${cols.join(', ')} FROM ${quoteIdent(schema)}.${quoteIdent(table)} AS t ORDER BY ${order.join(', ')} LIMIT $1`;
}

// --- The catalog --------------------------------------------------------------

export interface CatalogColumn {
  name: string;
  type: string;
  not_null: boolean;
  /** pg_stats.null_frac; null when the table was never analysed. */
  null_frac: number | null;
  /** pg_stats.n_distinct: a count when positive, minus a share of the rows when negative. */
  n_distinct: number | null;
}

export interface CatalogTable {
  schema: string;
  name: string;
  kind: 'table' | 'partitioned table' | 'view' | 'materialized view';
  /** The CSV this table was written to, relative to the served folder. */
  file: string;
  /** pg_class.reltuples: the catalog's estimate; null for a view or a table never analysed. */
  estimated_rows: number | null;
  rows_written: number;
  /** Why fewer rows were written than the table holds, or null. */
  cut: null | 'max_rows' | 'max_bytes';
  /** The order the rows were written in. */
  order: { by: 'primary key' | 'all columns'; columns: string[] };
  columns: CatalogColumn[];
  primary_key: string[] | null;
  unique: string[][];
  foreign_keys: { columns: string[]; references: { schema: string; table: string; columns: string[] } }[];
}

export interface Catalog {
  format: typeof CATALOG_FORMAT;
  database: string;
  server_version: number;
  max_rows: number;
  tables: CatalogTable[];
  /** Every file this run wrote, so the next run can remove one whose table is gone. */
  files: string[];
}

const KINDS: Record<string, CatalogTable['kind']> = { r: 'table', p: 'partitioned table', v: 'view', m: 'materialized view' };

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : []);

/** A file or folder name from a catalog name: letters (any script), digits,
 *  `_` and `-` kept, everything else `_`, so a name can never start with a dot,
 *  climb out with `..`, or nest with `/`. */
export function safeName(name: string): string {
  const s = name.normalize('NFC').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 120);
  return s || '_';
}

/** Each table's file, unique even on a case-insensitive disk: a later name that
 *  folds to an earlier one gets `-2`, `-3`, in catalog order. */
function assignFiles(tables: { schema: string; name: string }[], system: string | undefined): string[] {
  const taken = new Set<string>();
  return tables.map((t) => {
    const stem = system ? `${safeName(system)}/${safeName(t.schema)}.${safeName(t.name)}` : `${safeName(t.schema)}/${safeName(t.name)}`;
    let file = `${stem}.csv`;
    for (let i = 2; taken.has(file.toLowerCase()); i++) file = `${stem}-${i}.csv`;
    taken.add(file.toLowerCase());
    return file;
  });
}

// --- CSV ------------------------------------------------------------------------

/** One field as COPY … (FORMAT csv) writes it: quoted when it holds a quote, a
 *  comma or a line break, when it is the empty string (an unquoted empty field
 *  is NULL), or when it is `\.`. */
export function csvField(v: string | null): string {
  if (v === null) return '';
  if (v === '' || v === '\\.' || /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** What one line adds to the template's reply: its characters as JSON escapes them. */
const lineBytes = (line: string) => jsonStringBytes(`${line}\n`) - 2;

// --- The run ----------------------------------------------------------------------

const findingOf = (r: Record<string, unknown>): Finding => ({ kind: str(r.kind), role: str(r.role), object: r.object === null ? null : str(r.object) });

/** Refuses (throws RefusedError) unless the session is a read-only
 *  transaction under a role that passes every check of roleCheckSql — the
 *  ways to write or hand out access listed there, not a proof that no other
 *  way exists. Run at the start of every
 *  run, inside the transaction the run reads in. Returns the warnings: what
 *  every role may do, this one included (WARNINGS_SQL). */
export async function checkRole(query: Query, serverVersion: number, readOnly: string): Promise<Finding[]> {
  const findings: Finding[] = (await query(roleCheckSql(serverVersion))).map(findingOf);
  if (readOnly !== 'on') findings.unshift({ kind: 'transaction', role: '', object: null });
  if (findings.length) throw new RefusedError(findings);
  return (await query(WARNINGS_SQL)).map(findingOf);
}

/** The warning lines for the log: one sentence, the first ten names, the fix. */
export function warningLines(warnings: readonly Finding[]): string[] {
  const fns = warnings.filter((w) => w.kind === 'function').map((w) => printable(w.object ?? ''));
  if (!fns.length) return [];
  const shown = fns.slice(0, 10).join(', ');
  const more = fns.length > 10 ? ` and ${fns.length - 10} more` : '';
  return [
    `Warning: every role in this database, the extractor's included, may run ${fns.length} SECURITY DEFINER function${fns.length === 1 ? '' : 's'} with ${fns.length === 1 ? 'its' : 'their'} owner's rights: ${shown}${more}. The extractor never calls them and reads in a read-only transaction. To close it for a role that only reads, see "If it warns" in the guide (maplith.com/docs/mcp-template).`,
  ];
}

/** Files the extractor writes: owner read-write, group read, nobody else —
 *  the server reads them through its group (the runbook's maplith-bridge).
 *  Folders likewise. The umask can only narrow these. */
export const FILE_MODE = 0o640;
export const DIR_MODE = 0o750;

/** Written under a hidden name with a random suffix, created exclusively
 *  (`wx`: a file or a symlink planted at that name makes the write fail, it is
 *  never followed), then renamed over the target, so the server never serves
 *  half a file and nobody can steer the write elsewhere. */
function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: DIR_MODE });
  const parts = file.split(sep);
  const hidden = join(dirname(file), `.${parts[parts.length - 1]}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(hidden, text, { flag: 'wx', mode: FILE_MODE });
    renameSync(hidden, file);
  } catch (err) {
    rmSync(hidden, { force: true });
    throw err;
  }
}

/** The files the previous run wrote, from its catalog; [] when there is none or
 *  it cannot be read. Only paths that stay inside the folder and name a CSV. */
function previousFiles(catalogPath: string): string[] {
  let prev: unknown;
  try {
    prev = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch {
    return [];
  }
  const files = prev && typeof prev === 'object' && Array.isArray((prev as Catalog).files) ? (prev as Catalog).files : [];
  return files.filter(
    (f): f is string =>
      typeof f === 'string' && f.endsWith('.csv') && !isAbsolute(f) && !f.includes('\\') && !f.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('.')),
  );
}

export interface ExtractResult {
  catalog: Catalog;
  /** Every statement sent, in order, for the caller's own record. */
  statements: string[];
  /** What every role may do, this one included (WARNINGS_SQL). Also logged. */
  warnings: Finding[];
}

/** One run: verify the role, read the catalog, write one CSV per table, then
 *  the hidden catalog, then remove the files of tables that are gone. Always
 *  ends the transaction (ROLLBACK: it never had anything to commit). */
export async function extract(opts: ExtractOptions): Promise<ExtractResult> {
  const statements: string[] = [];
  const q: Query = (sql, params) => {
    statements.push(sql);
    return opts.query(sql, params);
  };
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.deadlineMs ?? 60 * 60 * 1000);
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxBytes = Math.min(opts.maxBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES);
  if (!Number.isInteger(maxRows) || maxRows < 1) throw new Error('maxRows must be a whole number above 0');
  const statementTimeout = opts.statementTimeoutMs ?? 5 * 60 * 1000;
  if (!Number.isInteger(statementTimeout) || statementTimeout < 1) throw new Error('statementTimeoutMs must be a whole number above 0');
  if (opts.system !== undefined && !opts.system.trim()) throw new Error('system must not be empty');
  mkdirSync(opts.out, { recursive: true, mode: DIR_MODE });
  const out = realpathSync(resolve(opts.out));

  let warnings: Finding[] = [];
  for (const sql of SESSION_SQL) await q(sql);
  await q(TIMEOUT_SQL, [String(statementTimeout)]);
  await q(BEGIN_SQL);
  try {
    const [info] = await q(SESSION_INFO_SQL);
    const version = Number(str(info?.version));
    warnings = await checkRole(q, version, str(info?.read_only));
    for (const line of warningLines(warnings)) log(line);

    const tableRows = await q(TABLES_SQL);
    for (const f of await q(FOREIGN_TABLES_SQL)) log(`${printable(str(f.name))}: skipped (a foreign table: a read there runs on another server)`);
    const oids = tableRows.map((t) => str(t.oid));
    const columnRows = oids.length ? await q(COLUMNS_SQL, [oids]) : [];
    const keyRows = oids.length ? await q(KEYS_SQL, [oids]) : [];
    const byOid = new Map(tableRows.map((t) => [str(t.oid), t]));
    const files = assignFiles(
      tableRows.map((t) => ({ schema: str(t.schema), name: str(t.name) })),
      opts.system,
    );

    const tables: CatalogTable[] = [];
    for (let ti = 0; ti < tableRows.length; ti++) {
      if (now() > deadline) throw new Error('Stopped: the run passed its deadline. The files written so far are complete; the rest were not refreshed.');
      const t = tableRows[ti];
      const oid = str(t.oid);
      const schema = str(t.schema);
      const name = str(t.name);
      const colNames = columnRows.filter((c) => str(c.oid) === oid);
      const readable = new Set(colNames.map((c) => str(c.name)));
      const keys = keyRows.filter((k) => str(k.oid) === oid && list(k.columns).every((c) => readable.has(c)));
      const pk = keys.find((k) => str(k.type) === 'p');
      const primaryKey = pk ? list(pk.columns) : null;
      const foreign_keys: CatalogTable['foreign_keys'] = [];
      for (const k of keys.filter((k) => str(k.type) === 'f')) {
        const ref = byOid.get(str(k.ref_oid));
        const refCols = list(k.ref_columns);
        const refReadable = new Set(columnRows.filter((c) => str(c.oid) === str(k.ref_oid)).map((c) => str(c.name)));
        // A key to a table the role cannot read names columns the owner
        // chose not to grant: left out.
        if (!ref || !refCols.every((c) => refReadable.has(c))) continue;
        foreign_keys.push({ columns: list(k.columns), references: { schema: str(ref.schema), table: str(ref.name), columns: refCols } });
      }
      const stats = new Map<string, { null_frac: number | null; n_distinct: number | null }>();
      for (const s of await q(STATS_SQL, [schema, name])) {
        if (!stats.has(str(s.name))) stats.set(str(s.name), { null_frac: num(s.null_frac), n_distinct: num(s.n_distinct) });
      }
      const columns: CatalogColumn[] = colNames.map((c) => ({
        name: str(c.name),
        type: str(c.type),
        not_null: c.not_null === true || c.not_null === 't',
        null_frac: stats.get(str(c.name))?.null_frac ?? null,
        n_distinct: stats.get(str(c.name))?.n_distinct ?? null,
      }));
      const entry: CatalogTable = {
        schema,
        name,
        kind: KINDS[str(t.kind)] ?? 'table',
        file: files[ti],
        estimated_rows: num(t.estimated_rows),
        rows_written: 0,
        cut: null,
        order: { by: primaryKey ? 'primary key' : 'all columns', columns: primaryKey ?? columns.map((c) => c.name) },
        columns,
        primary_key: primaryKey,
        unique: keys.filter((k) => str(k.type) === 'u').map((k) => list(k.columns)),
        foreign_keys,
      };
      if (!opts.checkOnly) {
        const written = await writeTable(q, out, entry, maxRows, maxBytes);
        entry.rows_written = written.rows;
        entry.cut = written.cut;
        log(`${entry.file}: ${written.rows} rows${written.cut ? ` (cut: ${written.cut === 'max_rows' ? `the first ${maxRows} rows` : 'what fits in the 8 MB the template serves'}, in ${entry.order.by} order)` : ''}`);
      } else {
        log(`${entry.file}: ${columns.length} columns readable, about ${entry.estimated_rows ?? 'an unknown number of'} rows`);
      }
      tables.push(entry);
    }

    const catalog: Catalog = {
      format: CATALOG_FORMAT,
      database: str(info?.database),
      server_version: version,
      max_rows: maxRows,
      tables,
      files: opts.checkOnly ? [] : tables.map((t) => t.file),
    };
    if (!opts.checkOnly) {
      const catalogDir = opts.system ? join(out, safeName(opts.system)) : out;
      const catalogPath = join(catalogDir, CATALOG_FILE);
      const keep = new Set(catalog.files);
      for (const f of previousFiles(catalogPath)) {
        if (keep.has(f)) continue;
        const abs = normalize(join(out, f));
        if (!abs.startsWith(out + sep)) continue;
        rmSync(abs, { force: true });
        log(`${f}: removed (its table is no longer readable)`);
      }
      atomicWrite(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    }
    return { catalog, statements, warnings };
  } catch (err) {
    // The ROLLBACK must not replace the error that ended the run: when the
    // connection is gone, the ROLLBACK fails too, and its "Connection
    // terminated" would hide the real cause.
    try {
      await q(END_SQL);
    } catch {
      // the first error is the one reported
    }
    throw err;
  } finally {
    if (statements[statements.length - 1] !== END_SQL) await q(END_SQL);
  }
}

/** Writes one table's CSV, atomically: under a hidden name, renamed when
 *  complete, so the template never serves half a file. The rows are a prefix
 *  of the table's total order, so two runs on the same data write the same
 *  bytes. A cut file opens with one line saying so, which the loader reads as
 *  a title above the header (Maplith's CSV reader) — except for a
 *  one-column table, where that line would be taken for the header; there the
 *  cut is stated in the catalog only. */
async function writeTable(q: Query, out: string, t: CatalogTable, maxRows: number, maxBytes: number): Promise<{ rows: number; cut: CatalogTable['cut'] }> {
  const names = t.columns.map((c) => c.name);
  const rows = await q(contentsSql(t.schema, t.name, names, t.primary_key), [maxRows + 1]);
  const header = names.map(csvField).join(',');
  const lines: string[] = [header];
  let bytes = 2 + lineBytes(header);
  let cut: CatalogTable['cut'] = rows.length > maxRows ? 'max_rows' : null;
  const take = Math.min(rows.length, maxRows);
  for (let i = 0; i < take; i++) {
    const r = rows[i];
    const line = names.map((_, ci) => csvField(r[`c${ci}`] === null || r[`c${ci}`] === undefined ? null : str(r[`c${ci}`]))).join(',');
    const add = lineBytes(line);
    if (bytes + add > maxBytes) {
      cut = 'max_bytes';
      break;
    }
    lines.push(line);
    bytes += add;
  }
  const written = lines.length - 1;
  if (cut && names.length > 1) {
    // No row estimate here: reltuples comes from ANALYZE's sample and can
    // move between runs on unchanged data, and the file must not.
    lines.unshift(csvField(`Maplith extract: the first ${written} rows of ${t.schema}.${t.name} in ${t.order.by} order - not the whole table`));
  }
  atomicWrite(join(out, ...t.file.split('/')), `${lines.join('\n')}\n`);
  return { rows: written, cut };
}

// --- The command line ---------------------------------------------------------------

export interface CliArgs {
  out: string;
  system?: string;
  maxRows?: number;
  statementTimeoutMs?: number;
  deadlineMs?: number;
  checkOnly: boolean;
}

/** The command line, strictly: an unknown flag is an error, and no flag takes SQL. */
export function parseArgs(argv: readonly string[], env: Record<string, string | undefined>): CliArgs {
  const args: CliArgs = { out: env.EXPORT_DIR ?? '', checkOnly: false };
  const whole = (flag: string, v: string | undefined) => {
    if (!v || !/^\d+$/.test(v) || Number(v) < 1) throw new Error(`${flag} needs a whole number above 0`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${a} needs a value`);
      return next;
    };
    if (a === '--out') args.out = v();
    else if (a === '--system') args.system = v();
    else if (a === '--max-rows') args.maxRows = whole(a, v());
    else if (a === '--statement-timeout') args.statementTimeoutMs = whole(a, v()) * 1000;
    else if (a === '--deadline') args.deadlineMs = whole(a, v()) * 60 * 1000;
    else if (a === '--check') args.checkOnly = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.out) throw new Error('Set EXPORT_DIR or pass --out: the folder the template serves');
  return args;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** URL parameters by which the operator chose a TLS mode of their own. */
const URL_TLS_PARAMS = ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat'];

/** Whether a DATABASE_URL needs the verified-TLS default: it names a host that
 *  is not this machine or a socket, and sets no TLS parameter. Without this a
 *  remote URL connected in the clear, because the driver uses TLS only when
 *  told. A URL that does not parse gets TLS: the safe side. */
export function urlNeedsTls(url: string, env: Record<string, string | undefined> = {}): boolean {
  if (/^socket:/i.test(url)) return false;
  // Read by hand, not with URL: a socket URL with credentials and no host
  // (postgres://u:p@/db?host=/var/run/postgresql) is valid to the driver and
  // an error to URL.
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)[^?#]*(?:\?([^#]*))?/i.exec(url);
  if (!m) return true;
  const params = new URLSearchParams(m[2] ?? '');
  if (URL_TLS_PARAMS.some((p) => params.has(p))) return false;
  let host: string;
  try {
    // `||`, not `??`: an empty ?host= names no host either.
    host = decodeURIComponent(params.get('host') || m[1]).replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  // No host in the URL: the driver takes PGHOST, so the PGHOST rule applies
  // (postgres:///db with PGHOST=db.remote.example went in the clear).
  if (host === '') host = env.PGHOST || 'localhost';
  return !(LOCAL_HOSTS.has(host) || host.startsWith('/'));
}

/** The PostgreSQL client the command line uses: node-postgres, pinned in
 *  package.json beside this file. Its connection settings are the standard
 *  PG* variables (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE)
 *  or DATABASE_URL, read by the driver itself. */
export interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}
export type PgClientClass = new (config: Record<string, unknown>) => PgClient;

async function loadPg(): Promise<PgClientClass> {
  const spec = 'pg';
  const mod = (await import(spec)) as { default?: { Client: PgClientClass }; Client?: PgClientClass };
  const Client = mod.default?.Client ?? mod.Client;
  if (!Client) throw new Error('The pg package did not load: run `npm ci --ignore-scripts` in the folder that holds this file');
  return Client;
}

/** Every secret the environment carries, so no line this program prints can
 *  hold one: the password, the whole connection URL and the password inside it. */
export function secretsOf(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  if (env.PGPASSWORD) out.add(env.PGPASSWORD);
  const url = env.DATABASE_URL;
  if (url) {
    out.add(url);
    try {
      const u = new URL(url);
      if (u.password) {
        out.add(u.password);
        out.add(decodeURIComponent(u.password));
      }
    } catch {
      // Not a URL: the whole value is already redacted.
    }
  }
  return [...out].filter((x) => x.length > 0).sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const sec of secrets) out = out.split(sec).join('[redacted]');
  return out;
}

/** The command line, as a function: the exit code it would end with. Every
 *  line it prints passes through `redact`, so the credential never reaches the
 *  terminal, a log file or a scheduler's mail, even inside a driver's error. It
 *  connects to the database and to nothing else. */
export async function runCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: { stdout: (line: string) => void; stderr: (line: string) => void; loadClient?: () => Promise<PgClientClass> },
): Promise<number> {
  const secrets = secretsOf(env);
  const say = (line: string) => io.stdout(redact(line, secrets));
  let client: PgClient | null = null;
  try {
    const args = parseArgs(argv, env);
    const Client = await (io.loadClient ?? loadPg)();
    const host = env.PGHOST ?? 'localhost';
    const config: Record<string, unknown> = { application_name: 'maplith-extract' };
    // TLS with a verified certificate unless the database is on this machine
    // or the operator chose a mode (PGSSLMODE, or an ssl setting in the URL).
    if (env.DATABASE_URL) {
      config.connectionString = env.DATABASE_URL;
      if (!env.PGSSLMODE && urlNeedsTls(env.DATABASE_URL, env)) config.ssl = { rejectUnauthorized: true };
    } else if (!env.PGSSLMODE && !LOCAL_HOSTS.has(host) && !host.startsWith('/')) config.ssl = { rejectUnauthorized: true };
    const c = new Client(config);
    client = c;
    await c.connect();
    const { catalog } = await extract({
      ...args,
      query: async (sql, params) => (await c.query(sql, params)).rows,
      log: say,
    });
    say(
      args.checkOnly
        ? `OK: the role is read-only and can read ${catalog.tables.length} tables. Nothing was written.`
        : `OK: wrote ${catalog.files.length} files to ${args.out}.`,
    );
    return 0;
  } catch (err) {
    // The message only: a stack or a driver error object is never printed in
    // full, and no message here carries a cell value.
    io.stderr(redact(err instanceof Error ? err.message : String(err), secrets));
    return 1;
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // already closed
      }
    }
  }
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) {
  runCli(process.argv.slice(2), process.env, { stdout: (l) => console.log(l), stderr: (l) => console.error(l) }).then((code) => {
    process.exitCode = code;
  });
}
