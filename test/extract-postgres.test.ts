import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CATALOG_FILE,
  RefusedError,
  SCHEMA_FILE,
  SCHEMA_FORMAT,
  SYSTEM_ID_SQL,
  databaseIdentity,
  fullXid,
  historyGoneBack,
  identityBase,
  firstEpoch,
  nextEpoch,
  type CatalogTable,
  type SchemaFile,
  STATS_SQL,
  contentsSql,
  csvField,
  extract,
  parseArgs,
  printable,
  quoteIdent,
  redact,
  runCli,
  safeName,
  secretsOf,
  TABLES_SQL,
  type Catalog,
  type PgClientClass,
  type ExtractOptions,
  type Query,
  urlNeedsTls,
} from '../extract-postgres.ts';
import { handle, listFiles, replyFits } from '../serve.ts';

/** The PostgreSQL extractor, against an in-process PostgreSQL 18 (PGlite). The fixture is built as the superuser;
 *  every run switches the session to the role under test with SET SESSION
 *  AUTHORIZATION, which moves session_user too, as a login would.
 *
 *  Cell values in the fixture carry the marker "cellvalue" so a test can say
 *  that none of them reached the catalog, a log line or an error text. */

const db = new PGlite();
const query: Query = async (sql, params) => (await db.query<Record<string, unknown>>(sql, params as unknown[] | undefined)).rows;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pg-extract-'));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE maplith_export LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ALTER ROLE maplith_export SET default_transaction_read_only = on;
    CREATE SCHEMA shop;
    CREATE TABLE shop.customers (id int PRIMARY KEY, email text UNIQUE, name text, vip boolean, created timestamptz, notes text);
    CREATE TABLE shop.orders (id int PRIMARY KEY, customer_id int REFERENCES shop.customers (id), total numeric(10, 2), placed date, status text);
    CREATE TABLE shop.events (kind text, at timestamptz, payload jsonb);
    CREATE TABLE shop.secret (x text);
    CREATE SEQUENCE shop.order_no;
    CREATE VIEW shop.big_orders AS SELECT id, total FROM shop.orders WHERE total > 100;
    INSERT INTO shop.customers VALUES
      (1, 'alice.cellvalue@example.com', 'Alice Cellvalue', true, '2026-01-02 03:04:05+02', 'cellvalue-note-1'),
      (2, 'bob.cellvalue@example.com', 'Bob, "the" Cellvalue', false, '2026-02-03 04:05:06+00', 'cellvalue-note-2'),
      (3, NULL, '', NULL, NULL, NULL),
      (4, 'dora.cellvalue@example.com', E'Dora\\nCellvalue', true, '2026-03-04 05:06:07+00', 'cellvalue-note-4');
    INSERT INTO shop.orders VALUES
      (10, 1, 99.50, '2026-01-05', 'cellvalue-open'), (11, 1, 250.00, '2026-01-06', 'cellvalue-paid'),
      (12, 2, 12.00, '2026-02-07', 'cellvalue-paid'), (13, 4, 130.25, '2026-03-08', NULL),
      (14, 4, 7.75, '2026-03-09', 'cellvalue-open');
    INSERT INTO shop.events VALUES
      ('cellvalue-b', '2026-01-01 00:00:00+00', '{"k": "cellvalue-1"}'), ('cellvalue-a', '2026-01-02 00:00:00+00', NULL),
      ('cellvalue-a', '2026-01-01 00:00:00+00', '{"k": "cellvalue-2"}'), (NULL, NULL, NULL), ('', NULL, NULL);
    INSERT INTO shop.secret VALUES ('cellvalue-secret');
    ANALYZE;
    GRANT USAGE ON SCHEMA shop TO maplith_export;
    GRANT SELECT (id, email, name, vip, created) ON shop.customers TO maplith_export;
    GRANT SELECT ON shop.orders, shop.events, shop.big_orders TO maplith_export;
  `);
});

afterAll(async () => {
  await db.close();
});

/** One extractor run as `role` (null: as the superuser), the session put back afterwards. */
async function runAs(role: string | null, opts: Partial<ExtractOptions> & { out: string }, q: Query = query) {
  if (role) await db.exec(`SET SESSION AUTHORIZATION ${quoteIdent(role)}`);
  const lines: string[] = [];
  try {
    return { ...(await extract({ query: q, log: (l) => lines.push(l), ...opts })), lines };
  } finally {
    await db.exec('SET SESSION AUTHORIZATION postgres; RESET ALL;');
  }
}

/** Every file under `dir`, hidden ones included, with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r);
      else out[r] = readFileSync(join(d, e.name), 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

const readCatalog = (dir: string): Catalog => JSON.parse(readFileSync(join(dir, CATALOG_FILE), 'utf8'));

/** Two tables with every kind of value whose text form a session setting
 *  could change, edge values included, and one with no key, duplicate rows
 *  and types that have no ordering of their own. The same fixture runs on a
 *  real server in extract-postgres-server.test.ts. */
const DETERMINISM_FIXTURE = `
  CREATE SCHEMA det;
  CREATE TYPE det.mood AS ENUM ('sad', 'ok', 'happy');
  CREATE TABLE det.wide (
    id int PRIMARY KEY, i2 smallint, i8 bigint, n numeric(20, 6), r real, d double precision, m money,
    t text, c char(3), b bytea, ok boolean, day date, tm time, tmz timetz, ts timestamp, tsz timestamptz,
    iv interval, u uuid, ip inet, net cidr, mac macaddr, j json, jb jsonb, ai int[], at text[],
    rng int4range, trng tstzrange, pt point, bits bit(4), vb varbit, mood det.mood, tsv tsvector
  );
  INSERT INTO det.wide VALUES
    (1, -32768, 9223372036854775807, 123456.789012, 3.4028235e38, 0.1, 1234.56, E'line\\nbreak, "quoted"', 'ab', '\\xdeadbeef', true,
     '2026-10-10', '23:59:59.999999', '12:00:00+05:30', '2026-01-01 00:00:00.5', '2026-03-29 01:30:00+01', '1 year 2 mons 3 days 04:05:06.7',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '192.168.0.1/24', '10.0.0.0/8', '08:00:2b:01:02:03', '{"b":1, "a":[1,2]}', '{"b":1, "a":[1,2]}',
     '{1,NULL,3}', '{"x,y",NULL,""}', '[1,10)', '[2026-01-01 00:00+00,2026-02-01 00:00+00)', '(1.5,-2)', B'1010', B'101', 'happy', 'the quick brown fox'),
    (2, 0, -1, 'NaN', 'NaN', 'Infinity', -0.01, 'æøå 漢字 🙂', NULL, '\\x', false,
     'infinity', '00:00', '00:00+00', '-infinity', 'infinity', '-1 days',
     NULL, '::1', '::/0', NULL, 'null', 'null',
     '{}', '{}', 'empty', NULL, NULL, B'0000', B'', 'sad', ''),
    (3, NULL, NULL, -0.000001, '-Infinity', -0.0, NULL, '', NULL, NULL, NULL,
     '0001-01-01 BC', NULL, NULL, '1999-12-31 23:59:59', '1970-01-01 00:00:00+00', '0',
     NULL, NULL, NULL, NULL, '[]', '[]',
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  CREATE TABLE det.loose (a text, b int, p point, j json);
  INSERT INTO det.loose VALUES ('x', 1, '(1,1)', '{"k":1}'), ('x', 1, '(1,1)', '{"k":1}'), (NULL, NULL, NULL, NULL),
    ('', 2, '(0,0)', '[]'), ('B', 3, '(2,2)', '{}'), ('a', 3, '(2,2)', '{}');
  ANALYZE det.wide;
  ANALYZE det.loose;
`;

describe('what the extractor reads and writes', () => {
  it('writes one CSV per readable table, a hidden catalog, and nothing the role may not read', async () => {
    const out = tmp();
    const { catalog } = await runAs('maplith_export', { out });
    expect(listFiles(out)).toEqual(['shop/big_orders.csv', 'shop/customers.csv', 'shop/events.csv', 'shop/maplith-schema.json', 'shop/orders.csv']);
    expect(existsSync(join(out, CATALOG_FILE))).toBe(true);
    expect(readCatalog(out)).toEqual(JSON.parse(JSON.stringify(catalog)));
    // Column-level grant: notes is not read, not named, not counted.
    const people = readFileSync(join(out, 'shop/customers.csv'), 'utf8');
    expect(people.split('\n')[0]).toBe('id,email,name,vip,created');
    expect(people).not.toContain('cellvalue-note');
    expect(JSON.stringify(catalog)).not.toContain('notes');
    expect(JSON.stringify(catalog)).not.toContain('secret');
  });

  it('writes the cells as COPY … (FORMAT csv, HEADER) does, NULL apart from the empty string', async () => {
    const out = tmp();
    await runAs('maplith_export', { out });
    expect(readFileSync(join(out, 'shop/customers.csv'), 'utf8')).toBe(
      [
        'id,email,name,vip,created',
        '1,alice.cellvalue@example.com,Alice Cellvalue,t,2026-01-02 01:04:05+00',
        '2,bob.cellvalue@example.com,"Bob, ""the"" Cellvalue",f,2026-02-03 04:05:06+00',
        '3,,"",,',
        '4,dora.cellvalue@example.com,"Dora\nCellvalue",t,2026-03-04 05:06:07+00',
        '',
      ].join('\n'),
    );
  });

  it('records the catalog: kinds, declared types, keys, catalog row counts and counts-only statistics', async () => {
    const out = tmp();
    const { catalog } = await runAs('maplith_export', { out });
    const t = (name: string) => catalog.tables.find((x) => x.name === name)!;
    expect(catalog.tables.map((x) => [x.name, x.kind])).toEqual([
      ['big_orders', 'view'],
      ['customers', 'table'],
      ['events', 'table'],
      ['orders', 'table'],
    ]);
    expect(t('orders').primary_key).toEqual(['id']);
    expect(t('orders').foreign_keys).toEqual([{ columns: ['customer_id'], references: { schema: 'shop', table: 'customers', columns: ['id'] } }]);
    expect(t('customers').unique).toEqual([['email']]);
    expect(t('orders').estimated_rows).toBe(5);
    expect(t('big_orders').estimated_rows).toBeNull();
    // The catalog entry's transaction id (xmin) is for the next run's history check.
    const [entry] = await query(`SELECT c.xmin::text AS rel, c.relnatts::int AS natts, a.xmin::text AS col FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'total' WHERE c.oid = 'shop.orders'::regclass`);
    expect(t('orders').columns.find((c) => c.name === 'total')).toEqual({ name: 'total', attnum: 3, type: 'numeric(10,2)', not_null: false, null_frac: 0, n_distinct: -1, xmin: entry.col });
    expect(t('orders').relid).toBe(Number((await query(`SELECT 'shop.orders'::regclass::oid::int AS r`))[0].r));
    expect(t('orders')).toMatchObject({ xmin: entry.rel, natts: entry.natts });
    expect(t('orders').columns.find((c) => c.name === 'status')!.null_frac).toBeCloseTo(0.2);
    expect(t('events').order).toEqual({ by: 'all columns', columns: ['kind', 'at', 'payload'] });
    // Counts only: every column carries exactly these keys, and no value of
    // the table appears anywhere in the catalog (most_common_vals of
    // orders.status would be "cellvalue-paid").
    for (const table of catalog.tables) for (const c of table.columns) expect(Object.keys(c).sort()).toEqual(['attnum', 'n_distinct', 'name', 'not_null', 'null_frac', 'type', 'xmin']);
    expect(readFileSync(join(out, CATALOG_FILE), 'utf8')).not.toMatch(/cellvalue/i);
    expect(STATS_SQL).not.toMatch(/most_common|histogram|correlation|elem/i);
  });

  it('orders rows by the primary key, or by every column when there is none', async () => {
    const out = tmp();
    await runAs('maplith_export', { out });
    expect(readFileSync(join(out, 'shop/events.csv'), 'utf8')).toBe(
      [
        'kind,at,payload',
        '"",,',
        'cellvalue-a,2026-01-01 00:00:00+00,"{""k"": ""cellvalue-2""}"',
        'cellvalue-a,2026-01-02 00:00:00+00,',
        'cellvalue-b,2026-01-01 00:00:00+00,"{""k"": ""cellvalue-1""}"',
        ',,',
        '',
      ].join('\n'),
    );
    expect(contentsSql('s', 't', ['a'], ['a'])).toBe(`SELECT CASE WHEN t."a" IS NULL THEN NULL ELSE format('%s', t."a") END AS c0 FROM "s"."t" AS t ORDER BY t."a" LIMIT $1`);
  });

  it('orders by the table\'s own column even when a column is named like an output column (c0, c1)', async () => {
    // A bare ORDER BY "c0" would bind to the output column c0, the text of c1.
    await db.exec(`
      CREATE TABLE shop.clash (c1 text, c0 int PRIMARY KEY);
      INSERT INTO shop.clash VALUES ('b', 1), ('a', 2), ('a', 3), ('c', 4);
      GRANT SELECT ON shop.clash TO maplith_export;
    `);
    try {
      const out = tmp();
      await runAs('maplith_export', { out });
      expect(readFileSync(join(out, 'shop/clash.csv'), 'utf8')).toBe('c1,c0\nb,1\na,2\na,3\nc,4\n');
      const cut = tmp();
      await runAs('maplith_export', { out: cut, maxRows: 2 });
      expect(readFileSync(join(cut, 'shop/clash.csv'), 'utf8').split('\n').slice(-3)).toEqual(['b,1', 'a,2', '']);
    } finally {
      await db.exec('DROP TABLE shop.clash');
    }
  });
});

describe('the schema file', () => {
  it('states each table\'s file, relation, columns with attribute numbers and types, keys and estimated rows, and no value', async () => {
    const out = tmp();
    const { catalog } = await runAs('maplith_export', { out });
    const text = readFileSync(join(out, 'shop', SCHEMA_FILE), 'utf8');
    const schema = JSON.parse(text) as SchemaFile;
    expect(schema.format).toBe(SCHEMA_FORMAT);
    expect(schema.database).toMatch(/^[0-9a-f]{32}$/);
    expect(schema.database).toBe(catalog.identity!.id);
    expect(schema.tables.map((t) => t.file)).toEqual(['big_orders.csv', 'customers.csv', 'events.csv', 'orders.csv']);
    const orders = schema.tables.find((t) => t.name === 'orders')!;
    const attnums = await query(`SELECT attname::text AS name, attnum::int AS attnum FROM pg_attribute WHERE attrelid = 'shop.orders'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`);
    expect(orders.columns.map((c) => ({ name: c.name, attnum: c.attnum }))).toEqual(attnums);
    expect(orders).toMatchObject({ schema: 'shop', kind: 'table', estimated_rows: 5, primary_key: ['id'], relid: catalog.tables.find((t) => t.name === 'orders')!.relid });
    // Names, numbers and types only: no statistic beyond the row estimate,
    // no value, and the column the role may not read is not named.
    for (const t of schema.tables) for (const c of t.columns) expect(Object.keys(c).sort()).toEqual(['attnum', 'name', 'not_null', 'type']);
    expect(text).not.toMatch(/cellvalue|null_frac|n_distinct|notes/i);
    // Served like any other file.
    expect(listFiles(out)).toContain(`shop/${SCHEMA_FILE}`);
  });

  it('keeps a column\'s attribute number through RENAME COLUMN, and gives a column dropped and added again a new one', async () => {
    await db.exec(`CREATE TABLE shop.renamed (id int PRIMARY KEY, a text, b text); INSERT INTO shop.renamed VALUES (1, 'x', 'y'); GRANT SELECT ON shop.renamed TO maplith_export;`);
    try {
      const attnumOf = async (name: string) => {
        const out = tmp();
        await runAs('maplith_export', { out });
        const t = (JSON.parse(readFileSync(join(out, 'shop', SCHEMA_FILE), 'utf8')) as SchemaFile).tables.find((x) => x.name === 'renamed')!;
        return t.columns.find((c) => c.name === name)?.attnum;
      };
      const a = await attnumOf('a');
      await db.exec('ALTER TABLE shop.renamed RENAME COLUMN a TO a_renamed');
      expect(await attnumOf('a_renamed')).toBe(a);
      const b = await attnumOf('b');
      await db.exec('ALTER TABLE shop.renamed DROP COLUMN b; ALTER TABLE shop.renamed ADD COLUMN b text; GRANT SELECT ON shop.renamed TO maplith_export;');
      const again = await attnumOf('b');
      expect(again).toBeGreaterThan(b!);
    } finally {
      await db.exec('DROP TABLE shop.renamed');
    }
  });

  it('states the database by a digest of the server\'s system identifier, and names none when the role may not read it', async () => {
    const out = tmp();
    const { catalog } = await runAs('maplith_export', { out });
    const sysId = String((await query('SELECT system_identifier::text AS s FROM pg_control_system()'))[0].s);
    expect(catalog.identity).toMatchObject({ from: 'system_identifier' });
    expect(catalog.identity!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(catalog)).not.toContain(sysId);
    expect(readFileSync(join(out, 'shop', SCHEMA_FILE), 'utf8')).not.toContain(sysId);
    // The same database, run again into the same folder: the same identity.
    // Into another folder, whose record begins at its run: another one,
    // since nothing the run reads tells this database from a copy of it.
    expect((await runAs('maplith_export', { out })).catalog.identity).toEqual(catalog.identity);
    expect((await runAs('maplith_export', { out: tmp() })).catalog.identity!.id).not.toBe(catalog.identity!.id);
    // A role that may not run pg_control_system(): no identity at all, and
    // no stand-in. A restore into a fresh server can give the same relation
    // ids, and pg_dump renumbers the attribute numbers, so nothing else the
    // role can read tells it apart: the schema file names no database, and
    // the log says why, once.
    const hidden: Query = async (sql, params) => {
      const rows = await query(sql, params);
      return sql.includes('has_function_privilege') ? rows.map((r) => ({ ...r, readable: false })) : rows;
    };
    const kept = tmp();
    const first = await runAs('maplith_export', { out: kept }, hidden);
    expect(first.catalog.identity).toBeNull();
    expect(first.catalog).not.toHaveProperty('install_id');
    expect(first.statements.some((x) => x.includes('pg_control_system()') && !x.includes('has_function_privilege'))).toBe(false);
    const schema = JSON.parse(readFileSync(join(kept, 'shop', SCHEMA_FILE), 'utf8')) as SchemaFile;
    expect(schema.database).toBeNull();
    expect(schema.tables.map((t) => t.name)).toEqual(['big_orders', 'customers', 'events', 'orders']);
    expect(first.lines.filter((l) => l.startsWith('database identity: not stated'))).toHaveLength(1);
    // The next run into the same folder states none either: nothing is kept to stand in for it.
    expect((await runAs('maplith_export', { out: kept }, hidden)).catalog.identity).toBeNull();
    // A server that refuses the call costs the identifier, never the run:
    // the savepoint takes the failed statement back, and the run goes on.
    const refusing: Query = async (sql, params) => (sql === SYSTEM_ID_SQL ? query('SELECT 1 / 0 AS system_identifier') : query(sql, params));
    const refused = await runAs('maplith_export', { out: tmp() }, refusing);
    expect(refused.catalog.identity).toBeNull();
    expect(refused.catalog.tables.map((t) => t.name)).toEqual(['big_orders', 'customers', 'events', 'orders']);
    expect(refused.statements).toContain('ROLLBACK TO SAVEPOINT maplith_identity');
    // Another database, server, timeline or reset of the server's statistics
    // is another identity, and so is another epoch of the history; no
    // identifier or timeline, no identity.
    const server = { systemIdentifier: '42', timeline: '1', statsReset: '2026-10-01 00:00:00+00' };
    const id = (s: typeof server, oid = '1', name = 'a', epoch = '') => databaseIdentity(identityBase(s, oid, name), epoch)?.id;
    const ids = [
      id(server),
      id(server, '2'),
      id(server, '1', 'b'),
      id({ ...server, systemIdentifier: '43' }),
      id({ ...server, timeline: '2' }),
      id({ ...server, statsReset: '2026-10-02 00:00:00+00' }),
      id(server, '1', 'a', firstEpoch()),
      id(server, '1', 'a', firstEpoch()),
    ];
    for (const x of ids) expect(x).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(ids).size).toBe(ids.length);
    // A record begins with an epoch no other holds; the history going back moves it on, never back.
    expect(firstEpoch()).toMatch(/^[0-9a-f]{16}$/);
    const e = firstEpoch();
    expect(nextEpoch(e, '751')).toMatch(/^[0-9a-f]{16}$/);
    expect(nextEpoch(e, '751')).not.toBe(e);
    expect(nextEpoch(nextEpoch(e, '751'), '751')).not.toBe(nextEpoch(e, '751'));
    expect(identityBase({ ...server, systemIdentifier: '' }, '1', 'a')).toBeNull();
    expect(identityBase({ ...server, timeline: '' }, '1', 'a')).toBeNull();
    expect(identityBase({ ...server, statsReset: '' }, '1', 'a')).toBeNull();
    expect(databaseIdentity(null)).toBeNull();
  });

  /** A server of its own with one table, the role, and a copy of its data
   *  directory taken later (a backup). */
  async function ownServer(): Promise<{ db: PGlite; q: Query; run: (q: Query, out: string) => Promise<{ catalog: Catalog; lines: string[] }> }> {
    const own = new PGlite();
    const q: Query = async (sql, params) => (await own.query<Record<string, unknown>>(sql, params as unknown[] | undefined)).rows;
    await own.exec(`
      CREATE ROLE maplith_export LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE SCHEMA shop;
      CREATE TABLE shop.orders (id int PRIMARY KEY, total numeric(10, 2), placed date);
      INSERT INTO shop.orders VALUES (1, 10.00, '2026-01-01'), (2, 20.00, '2026-01-02');
      GRANT USAGE ON SCHEMA shop TO maplith_export;
      GRANT SELECT ON shop.orders TO maplith_export;`);
    return { db: own, q, run: (rq, out) => runOn(own, rq, out) };
  }
  async function runOn(server: PGlite, q: Query, out: string): Promise<{ catalog: Catalog; lines: string[] }> {
    await server.exec(`SET SESSION AUTHORIZATION ${quoteIdent('maplith_export')}`);
    const lines: string[] = [];
    try {
      return { catalog: (await extract({ query: q, out, log: (l) => lines.push(l) })).catalog, lines };
    } finally {
      await server.exec('SET SESSION AUTHORIZATION postgres; RESET ALL;');
    }
  }
  /** A copy of the data directory started as a server of its own: what a
   *  restore from a snapshot, a base backup or a stopped server's copy
   *  gives. The system identifier, the database's and the table's oids and
   *  the attribute numbers are the copy's, and the attribute numbers the
   *  later state gave out are free again. */
  const restore = async (copy: Blob) => {
    const restored = new PGlite({ loadDataDir: copy });
    const q: Query = async (sql, params) => (await restored.query<Record<string, unknown>>(sql, params as unknown[] | undefined)).rows;
    return { db: restored, q };
  };
  const attnums = (c: Catalog) => Object.fromEntries(c.tables.find((t) => t.name === 'orders')!.columns.map((x) => [x.attnum, x.name]));

  it('names no database where the role may not read the server\'s statistics, and runs on', async () => {
    const { db: own, q, run } = await ownServer();
    await own.exec('REVOKE SELECT ON pg_catalog.pg_stat_bgwriter FROM PUBLIC');
    const out = tmp();
    const { catalog, lines } = await run(q, out);
    expect(catalog.identity).toBeNull();
    expect(catalog.history).toBeNull();
    expect(catalog.tables.map((t) => t.name)).toEqual(['orders']);
    expect(lines.filter((l) => l.startsWith('database identity: not stated'))).toHaveLength(1);
    expect((JSON.parse(readFileSync(join(out, 'shop', SCHEMA_FILE), 'utf8')) as SchemaFile).database).toBeNull();
    await own.close();
  });

  it('states another identity after a restore of an earlier copy and new DDL, where the reused attribute numbers name other columns', async () => {
    const { db: original, q, run } = await ownServer();
    const out = tmp();
    const v1 = await run(q, out);
    const backup = await original.dumpDataDir('none');
    await original.exec(`ALTER TABLE shop.orders ADD COLUMN billing_email text; ALTER TABLE shop.orders ADD COLUMN shipping_email text; GRANT SELECT ON shop.orders TO maplith_export;`);
    const v2 = await run(q, out);
    // The history went on: the same identity, and the epoch it started with.
    expect(v2.catalog.identity).toEqual(v1.catalog.identity);
    expect(v2.catalog.history!.epoch).toMatch(/^[0-9a-f]{16}$/);
    expect(v2.catalog.history!.epoch).toBe(v1.catalog.history!.epoch);
    expect(attnums(v2.catalog)).toMatchObject({ 4: 'billing_email', 5: 'shipping_email' });
    await original.close();

    // The backup restored, and the columns added again in the other order:
    // the same system identifier, database oid, relation id and attribute
    // numbers, now naming the other columns.
    const { db: restored, q: rq } = await restore(backup);
    await restored.exec(`ALTER TABLE shop.orders ADD COLUMN shipping_email text; ALTER TABLE shop.orders ADD COLUMN billing_email text; GRANT SELECT ON shop.orders TO maplith_export;`);
    const v3 = await runOn(restored, rq, out);
    expect(v3.catalog.tables[0].relid).toBe(v2.catalog.tables[0].relid);
    expect(attnums(v3.catalog)).toMatchObject({ 4: 'shipping_email', 5: 'billing_email' });
    expect(v3.catalog.identity!.id).not.toBe(v2.catalog.identity!.id);
    const schema = JSON.parse(readFileSync(join(out, 'shop', SCHEMA_FILE), 'utf8')) as SchemaFile;
    expect(schema.database).toBe(v3.catalog.identity!.id);
    await restored.close();
  });

  it('tells a restore apart by the catalog alone, where the server\'s statistics came back with the copy (a copy taken while the server was stopped)', async () => {
    const { db: original, q, run } = await ownServer();
    // A stopped server's copy keeps the statistics' last reset: hold it still.
    const [{ stats_reset: kept }] = await q('SELECT stats_reset::text AS stats_reset FROM pg_stat_bgwriter');
    const still =
      (inner: Query): Query =>
      async (sql, params) => {
        const rows = await inner(sql, params);
        return sql === SYSTEM_ID_SQL ? rows.map((r) => ({ ...r, stats_reset: kept })) : rows;
      };
    const out = tmp();
    await run(still(q), out);
    const backup = await original.dumpDataDir('none');
    await original.exec(`ALTER TABLE shop.orders ADD COLUMN billing_email text; ALTER TABLE shop.orders ADD COLUMN shipping_email text; GRANT SELECT ON shop.orders TO maplith_export;`);
    const v2 = await run(still(q), out);
    // A RENAME COLUMN goes on from the history, under the same identity.
    await original.exec(`ALTER TABLE shop.orders RENAME COLUMN placed TO placed_on;`);
    const renamed = await run(still(q), out);
    expect(renamed.catalog.identity).toEqual(v2.catalog.identity);
    expect(renamed.lines.filter((l) => l.startsWith('database history:'))).toEqual([]);
    await original.close();

    const { db: restored, q: rq } = await restore(backup);
    const rstill = still(rq);
    // Restored, and read before any DDL (into a copy of the folder, so the
    // run below still compares with the same previous run): the relation
    // has fewer attribute numbers than the previous run read.
    const before = tmp();
    writeFileSync(join(before, CATALOG_FILE), readFileSync(join(out, CATALOG_FILE)));
    const early = await runOn(restored, rstill, before);
    expect(early.catalog.identity!.id).not.toBe(renamed.catalog.identity!.id);
    expect(early.lines.filter((l) => l.startsWith('database history:'))).toEqual(['database history: shop.orders has fewer attribute numbers than at the previous run. A restore of an earlier copy does that, so this run states the database under another identity than the previous run']);

    // Restored, then the columns added again in the other order before the
    // next run: their entries were written under transaction ids the
    // restored server gave out again, below the previous run's horizon.
    await restored.exec(`ALTER TABLE shop.orders ADD COLUMN shipping_email text; ALTER TABLE shop.orders ADD COLUMN billing_email text; GRANT SELECT ON shop.orders TO maplith_export;`);
    const v3 = await runOn(restored, rstill, out);
    expect(attnums(v3.catalog)).toMatchObject({ 4: 'shipping_email', 5: 'billing_email' });
    expect(v3.catalog.identity!.id).not.toBe(renamed.catalog.identity!.id);
    expect(v3.lines.filter((l) => l.startsWith('database history:'))).toHaveLength(1);
    expect(v3.catalog.history!.epoch).toMatch(/^[0-9a-f]{16}$/);
    // A folder with no record to go on from (emptied, or another one) does
    // not take the restored database for the one read before either: its
    // record begins at this run.
    expect((await runOn(restored, rstill, tmp())).catalog.identity!.id).not.toBe(renamed.catalog.identity!.id);
    // The next run goes on from the restored history: it keeps the new epoch.
    await restored.exec(`ALTER TABLE shop.orders RENAME COLUMN total TO amount;`);
    const v4 = await runOn(restored, rstill, out);
    expect(v4.catalog.identity).toEqual(v3.catalog.identity);
    expect(v4.lines.filter((l) => l.startsWith('database history:'))).toEqual([]);
    await restored.close();
  });

  it('states another identity in a folder whose record begins, wherever the database stands: a stopped server\'s copy restored and changed by as many transactions reaches the original\'s horizon', async () => {
    const { db: original, q, run } = await ownServer();
    // A stopped server's copy keeps the statistics' last reset: hold it still.
    const [{ stats_reset: kept }] = await q('SELECT stats_reset::text AS stats_reset FROM pg_stat_bgwriter');
    const still =
      (inner: Query): Query =>
      async (sql, params) => {
        const rows = await inner(sql, params);
        return sql === SYSTEM_ID_SQL ? rows.map((r) => ({ ...r, stats_reset: kept })) : rows;
      };
    const backup = await original.dumpDataDir('none');
    const add = (name: string, k: number) => `ALTER TABLE shop.orders ADD COLUMN ${name} text; UPDATE shop.orders SET ${name} = 'buyer' || (id * ${k}) || '@shop.example.test'; GRANT SELECT ON shop.orders TO maplith_export;`;
    await original.exec(add('billing_email', 1));
    const v1 = await run(still(q), tmp());
    await original.close();
    // The backup restored into a fresh install (another folder, no record),
    // and another column added by the same number of transactions, as a
    // scripted migration does.
    const { db: restored, q: rq } = await restore(backup);
    await restored.exec(add('contact_email', 7));
    const v2 = await runOn(restored, still(rq), tmp());
    // Everything the run reads of the server is the same, the horizon too,
    // and the same relation and attribute number name another column.
    expect(v2.catalog.history!.base).toBe(v1.catalog.history!.base);
    expect(v2.catalog.history!.horizon).toBe(v1.catalog.history!.horizon);
    expect(v2.catalog.tables[0].relid).toBe(v1.catalog.tables[0].relid);
    expect(attnums(v1.catalog)).toMatchObject({ 4: 'billing_email' });
    expect(attnums(v2.catalog)).toMatchObject({ 4: 'contact_email' });
    // Each record began with an epoch of its own: another identity.
    expect(v2.catalog.history!.epoch).not.toBe(v1.catalog.history!.epoch);
    expect(v2.catalog.identity!.id).not.toBe(v1.catalog.identity!.id);
    await restored.close();
  });

  it('states another identity after a restore that has since passed the previous run\'s horizon, by the reset of the server\'s statistics; the one restore it cannot see is a stopped server\'s copy that did that', async () => {
    const { db: original, q, run } = await ownServer();
    // What the run read of the server's statistics, as it read it.
    let kept: unknown;
    const seen: Query = async (sql, params) => {
      const rows = await q(sql, params);
      if (sql === SYSTEM_ID_SQL) kept = rows[0].stats_reset;
      return rows;
    };
    const out = tmp();
    await run(q, out);
    const backup = await original.dumpDataDir('none');
    await original.exec(`ALTER TABLE shop.orders ADD COLUMN billing_email text; ALTER TABLE shop.orders ADD COLUMN shipping_email text; GRANT SELECT ON shop.orders TO maplith_export;`);
    const v2 = await run(seen, out);
    expect(kept).toBeTruthy();
    await original.close();
    const copy = tmp();
    writeFileSync(join(copy, CATALOG_FILE), readFileSync(join(out, CATALOG_FILE)));

    // Restored, then more transactions than the later state had run before
    // the DDL: the new entries are newer than the previous run's horizon,
    // so the catalog alone cannot tell them from a rename.
    const { db: restored, q: rq } = await restore(backup);
    await restored.exec('CREATE TABLE public.scratch (n int)');
    for (let i = 0; i < 4; i++) await restored.exec(`INSERT INTO public.scratch VALUES (${i})`);
    await restored.exec(`ALTER TABLE shop.orders ADD COLUMN shipping_email text; ALTER TABLE shop.orders ADD COLUMN billing_email text; GRANT SELECT ON shop.orders TO maplith_export;`);
    const v3 = await runOn(restored, rq, out);
    expect(attnums(v3.catalog)).toMatchObject({ 4: 'shipping_email', 5: 'billing_email' });
    expect(v3.lines.filter((l) => l.startsWith('database history:'))).toEqual([]);
    // The start from the copy reset the server's statistics: another identity.
    expect(v3.catalog.identity!.id).not.toBe(v2.catalog.identity!.id);
    // A copy taken while the server was stopped brings its statistics back
    // with it. Then nothing a read-only role can read tells the restore
    // apart, and the identity stays: the case the README names.
    const still: Query = async (sql, params) => {
      const rows = await rq(sql, params);
      return sql === SYSTEM_ID_SQL ? rows.map((r) => ({ ...r, stats_reset: kept })) : rows;
    };
    expect((await runOn(restored, still, copy)).catalog.identity).toEqual(v2.catalog.identity);
    await restored.close();
  });

  it('reads the history check from the catalog it kept: what tells the history went back, and what does not', () => {
    const col = (attnum: number, name: string, xmin: string) => ({ name, attnum, type: 'text', not_null: false, null_frac: null, n_distinct: null, xmin });
    const table = (xmin: string, natts: number, columns: ReturnType<typeof col>[], name = 'orders'): CatalogTable => ({
      schema: 'shop', name, relid: 16400, xmin, natts, kind: 'table', file: 'shop/orders.csv', estimated_rows: null, rows_written: 0, cut: null,
      order: { by: 'all columns', columns: [] }, columns, primary_key: null, unique: [], foreign_keys: [],
    });
    const prev = { history: { base: 'b', epoch: '0123456789abcdef', horizon: '800' }, tables: [table('760', 5, [col(1, 'id', '700'), col(4, 'billing_email', '760'), col(5, 'shipping_email', '760')])] } as Partial<Catalog>;
    const check = (t: CatalogTable, next = '900') => historyGoneBack(prev, 'b', [t], next);
    // Went on: nothing changed; a rename and a column added after the previous run.
    expect(check(table('760', 5, [col(1, 'id', '700'), col(4, 'billing_email', '760'), col(5, 'shipping_email', '760')]))).toBeNull();
    expect(check(table('850', 6, [col(1, 'id', '700'), col(4, 'invoice_email', '850'), col(5, 'shipping_email', '760'), col(6, 'notes', '850')]))).toBeNull();
    // A column the previous run did not read tells nothing, and nor does one it no longer reads.
    expect(check(table('760', 5, [col(1, 'id', '700'), col(2, 'secret', '650')]))).toBeNull();
    // Gone back: fewer attribute numbers; an entry rewritten under the id the
    // previous run read; an entry older than its horizon that it did not read.
    expect(check(table('790', 3, [col(1, 'id', '700')]))).toMatch(/fewer attribute numbers/);
    expect(check(table('760', 5, [col(1, 'id', '700'), col(4, 'shipping_email', '760'), col(5, 'billing_email', '760')]))).toMatch(/attribute 4: its catalog entry changed under the transaction id/);
    expect(check(table('760', 5, [col(1, 'id', '700'), col(4, 'billing_email', '761'), col(5, 'shipping_email', '760')]))).toMatch(/attribute 4: its catalog entry was written before the previous run/);
    expect(check(table('790', 5, [col(1, 'id', '700')]))).toMatch(/^shop\.orders: its catalog entry was written before/);
    expect(check(table('760', 5, [col(1, 'id', '700')], 'returns'))).toMatch(/^shop\.returns: its catalog entry changed under/);
    // 64-bit ids: a 32-bit id is read as the latest one below the next id.
    expect(fullXid('5', 2n ** 32n + 10n)).toBe(2n ** 32n + 5n);
    expect(fullXid('20', 2n ** 32n + 10n)).toBe(20n);
    expect(fullXid('2', 900n)).toBeNull();
    expect(check(table('760', 5, [col(1, 'id', '700'), col(4, 'billing_email', '761')]), String(2n ** 32n + 900n))).toBeNull();
    // Nothing to compare: another base, no horizon, or no catalog.
    expect(historyGoneBack(prev, 'other', [table('790', 3, [])], '900')).toBeNull();
    expect(historyGoneBack({ ...prev, history: { base: 'b', epoch: '0123456789abcdef', horizon: '' } }, 'b', [table('790', 3, [])], '900')).toBeNull();
    expect(historyGoneBack(null, 'b', [table('790', 3, [])], '900')).toBeNull();
  });
});

describe('determinism', () => {
  it('two runs on the same database write the same bytes, and a folder whose record begins differs only in the database it states', async () => {
    const a = tmp();
    const b = tmp();
    await runAs('maplith_export', { out: a });
    const first = snapshot(a);
    await runAs('maplith_export', { out: a }); // a rerun into the same folder
    expect(snapshot(a)).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([CATALOG_FILE, 'shop/big_orders.csv', 'shop/customers.csv', 'shop/events.csv', 'shop/maplith-schema.json', 'shop/orders.csv']);
    // Another folder: the same CSV files; its record of the history begins
    // with an epoch of its own, so its schema file and hidden catalog state
    // another database, and differ in nothing else.
    await runAs('maplith_export', { out: b });
    const other = snapshot(b);
    const sansIdentity = (files: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(files).map(([f, text]) => {
          if (f === CATALOG_FILE) {
            const c = JSON.parse(text) as Catalog;
            return [f, { ...c, identity: { ...c.identity, id: '' }, history: { ...c.history, epoch: '' } }];
          }
          return [f, f.endsWith(SCHEMA_FILE) ? { ...(JSON.parse(text) as SchemaFile), database: '' } : text];
        }),
      );
    expect(sansIdentity(other)).toEqual(sansIdentity(first));
    expect(readCatalog(b).identity!.id).not.toBe(readCatalog(a).identity!.id);
    expect((JSON.parse(other[`shop/${SCHEMA_FILE}`]) as SchemaFile).database).toBe(readCatalog(b).identity!.id);
  });

  it('writes the same bytes whatever the session\'s settings, and whatever order the rows lie in on disk', async () => {
    await db.exec(`${DETERMINISM_FIXTURE}
      CREATE ROLE det_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT USAGE ON SCHEMA det TO det_reader;
      GRANT SELECT ON det.wide, det.loose TO det_reader;`);
    try {
      const a = tmp();
      await runAs('det_reader', { out: a });
      // Every setting a value's text form depends on, set otherwise, and the
      // rows moved on disk: an UPDATE writes a row's new version at the end.
      await db.exec(`UPDATE det.wide SET t = t WHERE id = 1; UPDATE det.loose SET b = b WHERE a = 'x';`);
      // The next run of the same folder, written apart to compare: its
      // history went on through the UPDATE.
      const b = tmp();
      writeFileSync(join(b, CATALOG_FILE), readFileSync(join(a, CATALOG_FILE)));
      await db.exec(`SET TimeZone = 'Pacific/Chatham'; SET DateStyle = 'SQL, DMY'; SET IntervalStyle = 'sql_standard';
        SET extra_float_digits = -15; SET bytea_output = 'escape'; SET search_path = det, public;
        SET SESSION AUTHORIZATION det_reader`);
      try {
        await extract({ query, out: b });
      } finally {
        await db.exec('SET SESSION AUTHORIZATION postgres; RESET ALL;');
      }
      // Every byte, but the hidden catalog's snapshot horizon: the UPDATE
      // took a transaction id, so the second run's horizon is later.
      const horizon = (d: string) => BigInt(readCatalog(d).history!.horizon);
      expect(horizon(b)).toBeGreaterThan(horizon(a));
      const bytes = (d: string) => Object.fromEntries(Object.keys(snapshot(d)).map((f) => [f, (f === CATALOG_FILE ? Buffer.from(JSON.stringify({ ...readCatalog(d), history: { ...readCatalog(d).history, horizon: '' } })) : readFileSync(join(d, f))).toString('hex')]));
      expect(bytes(b)).toEqual(bytes(a));
      const wide = readFileSync(join(a, 'det/wide.csv'), 'utf8');
      // The fixed settings, as written: UTC, ISO dates, hex bytea, shortest floats.
      expect(wide).toContain(',2026-03-29 00:30:00+00,');
      expect(wide).toContain(',\\xdeadbeef,');
      expect(wide).toContain(',0.1,');
      expect(wide).toContain(',"$1,234.56",');
      expect(wide).toContain(',1 year 2 mons 3 days 04:05:06.7,');
      expect(readFileSync(join(a, 'det/loose.csv'), 'utf8').split('\n').filter((l) => l.startsWith('x,1,')).length).toBe(2);
    } finally {
      await db.exec('DROP SCHEMA det CASCADE; DROP ROLE det_reader;');
    }
  });

  it('cuts a table over the row cap to a prefix of its order, said in the first line', async () => {
    const out = tmp();
    const { catalog } = await runAs('maplith_export', { out, maxRows: 3 });
    const orders = readFileSync(join(out, 'shop/orders.csv'), 'utf8').split('\n');
    // No row estimate in the line: reltuples is ANALYZE's sample and may move
    // between runs on unchanged data; the file must not.
    expect(orders[0]).toBe('Maplith extract: the first 3 rows of shop.orders in primary key order - not the whole table');
    expect(orders.slice(1, 5).map((l) => l.split(',')[0])).toEqual(['id', '10', '11', '12']);
    expect(catalog.tables.find((t) => t.name === 'orders')).toMatchObject({ rows_written: 3, cut: 'max_rows' });
  });

  it('a fresh ANALYZE moves no byte of a CSV, cut or not', async () => {
    const a = tmp();
    const b = tmp();
    await runAs('maplith_export', { out: a, maxRows: 3 });
    await db.exec('ANALYZE');
    await runAs('maplith_export', { out: b, maxRows: 3 });
    const csv = (d: string) => Object.fromEntries(Object.entries(snapshot(d)).filter(([f]) => f.endsWith('.csv')));
    expect(csv(a)).toEqual(csv(b));
  });

  it('cuts a table over 8 MB so the template serves it', async () => {
    await db.exec(`
      CREATE TABLE shop.wide (id int PRIMARY KEY, body text);
      INSERT INTO shop.wide SELECT g, repeat(md5(g::text), 160) FROM generate_series(1, 2000) g;
      ANALYZE shop.wide;
      GRANT SELECT ON shop.wide TO maplith_export;
    `);
    try {
      const out = tmp();
      const { catalog } = await runAs('maplith_export', { out });
      const wide = catalog.tables.find((t) => t.name === 'wide')!;
      expect(wide.cut).toBe('max_bytes');
      expect(wide.rows_written).toBeGreaterThan(1000);
      expect(wide.rows_written).toBeLessThan(2000);
      expect(listFiles(out)).toContain('shop/wide.csv');
      expect(replyFits(join(out, 'shop/wide.csv'), 'exports://shop/wide.csv')).toBe(true);
      const reply = handle({ root: out, name: 'exports' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'exports://shop/wide.csv' } })) as { result?: unknown };
      expect(reply.result).toBeDefined();
    } finally {
      await db.exec('DROP TABLE shop.wide');
    }
  });
});

describe('what the extractor must never do', () => {
  /** A role that has `setup` on top of what maplith_export has. */
  async function refusedFor(name: string, setup: string, opts: { as?: string | null } = {}) {
    await db.exec(`
      CREATE ROLE ${name} LOGIN;
      GRANT USAGE ON SCHEMA shop TO ${name};
      GRANT SELECT ON shop.orders TO ${name};
      ${setup}
    `);
    const out = tmp();
    let err: unknown;
    try {
      await runAs(opts.as === undefined ? name : opts.as, { out });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RefusedError);
    // Refused before a single file was written.
    expect(readdirSync(out)).toEqual([]);
    expect((err as Error).message).not.toMatch(/cellvalue/i);
    return (err as RefusedError).reasons;
  }

  it('the read-only role runs, and every statement it sends is a read', async () => {
    const out = tmp();
    const { statements, lines } = await runAs('maplith_export', { out });
    for (const sql of statements) {
      expect(sql).toMatch(/^(SELECT|WITH|SET|BEGIN|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)\b/);
      // Outside quoted identifiers and string literals: no write, DDL, COPY, lock or call.
      const bare = sql.replace(/"(?:[^"]|"")*"/g, '""').replace(/'(?:[^']|'')*'/g, "''");
      expect(bare).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE|CREATE|DROP|ALTER|COPY|GRANT|REVOKE|LOCK|CALL|DO|VACUUM|ANALYZE|REFRESH|NEXTVAL|SETVAL|LO_\w+|DBLINK\w*|PG_\w*FILE\w*)\b/i);
    }
    expect(statements).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(lines.join('\n')).not.toMatch(/cellvalue/i);
  });

  it('refuses a superuser', async () => {
    const reasons = await (async () => {
      try {
        await runAs(null, { out: tmp() });
      } catch (e) {
        return (e as RefusedError).reasons;
      }
      return [];
    })();
    expect(reasons).toContainEqual({ kind: 'attribute', role: 'postgres', object: 'SUPERUSER' });
  });

  it.each(['CREATEROLE', 'CREATEDB', 'BYPASSRLS', 'REPLICATION'])('refuses a role with %s', async (attr) => {
    const name = `attr_${attr.toLowerCase()}`;
    const reasons = await refusedFor(name, `ALTER ROLE ${name} ${attr};`);
    expect(reasons).toContainEqual({ kind: 'attribute', role: name, object: attr });
  });

  it.each([
    ['insert', 'GRANT INSERT ON shop.events TO priv_insert;'],
    ['update', 'GRANT UPDATE ON shop.events TO priv_update;'],
    ['delete', 'GRANT DELETE ON shop.events TO priv_delete;'],
    ['truncate', 'GRANT TRUNCATE ON shop.events TO priv_truncate;'],
    ['references', 'GRANT REFERENCES ON shop.events TO priv_references;'],
    ['trigger', 'GRANT TRIGGER ON shop.events TO priv_trigger;'],
    ['maintain', 'GRANT MAINTAIN ON shop.events TO priv_maintain;'],
    ['column', 'GRANT UPDATE (status) ON shop.orders TO priv_column;'],
    ['secret', 'GRANT INSERT ON shop.secret TO priv_secret;'],
  ])('refuses a role with a write privilege on a relation (%s)', async (what, grant) => {
    const reasons = await refusedFor(`priv_${what}`, grant);
    expect(reasons.some((r) => r.kind === 'relation' && r.role === `priv_${what}`)).toBe(true);
  });

  it('refuses a write privilege even when the role is set to read-only transactions', async () => {
    const reasons = await refusedFor('ro_but_insert', 'ALTER ROLE ro_but_insert SET default_transaction_read_only = on; GRANT INSERT ON shop.orders TO ro_but_insert;');
    expect(reasons).toContainEqual({ kind: 'relation', role: 'ro_but_insert', object: 'shop.orders' });
  });

  it('refuses a default privilege that would grant more than reading on new objects, and takes one that grants SELECT', async () => {
    await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA shop GRANT SELECT ON TABLES TO maplith_export');
    try {
      await runAs('maplith_export', { out: tmp(), checkOnly: true });
      const reasons = await refusedFor('defpriv', 'ALTER DEFAULT PRIVILEGES IN SCHEMA shop GRANT INSERT ON TABLES TO defpriv;');
      expect(reasons).toContainEqual({ kind: 'default privilege', role: 'defpriv', object: 'r' });
      expect(new RefusedError(reasons).message).toContain('defpriv would be granted more than reading on every new table (ALTER DEFAULT PRIVILEGES)');
    } finally {
      await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA shop REVOKE SELECT ON TABLES FROM maplith_export; ALTER DEFAULT PRIVILEGES IN SCHEMA shop REVOKE INSERT ON TABLES FROM defpriv;');
    }
  });

  it('names database objects in its messages as plain text: no control character, no endless name', () => {
    expect(printable('ok\u001b[2J\u001b[31mIGNORE\nrun this')).toBe('ok?[2J?[31mIGNORE?run this');
    expect(printable('x'.repeat(500))).toHaveLength(201);
    const err = new RefusedError([{ kind: 'function', role: 'r', object: 'function s."a\u001b[2Jb"()' }]);
    expect(err.message).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/);
  });

  it('refuses a role that may advance a sequence', async () => {
    const reasons = await refusedFor('seq_usage', 'GRANT USAGE ON SEQUENCE shop.order_no TO seq_usage;');
    expect(reasons).toContainEqual({ kind: 'sequence', role: 'seq_usage', object: 'shop.order_no' });
  });

  it('refuses a role that owns a table', async () => {
    const reasons = await refusedFor('owns_table', 'CREATE TABLE shop.owned (x int); ALTER TABLE shop.owned OWNER TO owns_table;');
    expect(reasons).toContainEqual({ kind: 'owner', role: 'owns_table', object: 'shop.owned' });
    await db.exec('DROP TABLE shop.owned');
  });

  it('refuses CREATE on a schema, also through PUBLIC as PostgreSQL 14 grants it on public', async () => {
    expect(await refusedFor('schema_create', 'GRANT CREATE ON SCHEMA shop TO schema_create;')).toContainEqual({ kind: 'schema', role: 'schema_create', object: 'shop' });
    await db.exec('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
      expect(await refusedFor('schema_public', '')).toContainEqual({ kind: 'schema', role: 'schema_public', object: 'public' });
    } finally {
      await db.exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    }
  });

  it('refuses CREATE on the database', async () => {
    const reasons = await refusedFor('db_create', 'GRANT CREATE ON DATABASE postgres TO db_create;');
    expect(reasons).toContainEqual({ kind: 'database', role: 'db_create', object: 'postgres' });
  });

  it('refuses write access to a large object through its access list, to the role or to PUBLIC; reading one is fine', async () => {
    await db.exec('SELECT lo_create(97901); SELECT lo_create(97902); GRANT SELECT ON LARGE OBJECT 97901 TO maplith_export;');
    try {
      // SELECT on a large object is reading: the read-only role still runs.
      await runAs('maplith_export', { out: tmp(), checkOnly: true });
      expect(await refusedFor('lo_update', 'GRANT UPDATE ON LARGE OBJECT 97901 TO lo_update;')).toContainEqual({ kind: 'large object', role: 'lo_update', object: 'large object 97901' });
      await db.exec('GRANT UPDATE ON LARGE OBJECT 97902 TO PUBLIC');
      expect(await refusedFor('lo_public', '')).toContainEqual({ kind: 'large object', role: 'lo_public', object: 'large object 97902' });
    } finally {
      await db.exec('SELECT lo_unlink(97901); SELECT lo_unlink(97902);');
    }
  });

  it('refuses when lo_compat_privileges turns the large-object checks off for every role', async () => {
    await db.exec('SET lo_compat_privileges = on');
    const out = tmp();
    // runAs resets the setting afterwards (RESET ALL).
    await expect(runAs('maplith_export', { out })).rejects.toMatchObject({ reasons: [{ kind: 'setting', role: 'maplith_export', object: 'lo_compat_privileges' }] });
    expect(readdirSync(out)).toEqual([]);
  });

  it('refuses EXECUTE granted to the role on any SECURITY DEFINER function, and only warns when every role has it through PUBLIC', async () => {
    await db.exec(`
      CREATE FUNCTION shop.bump() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'UPDATE shop.orders SET status = status';
      REVOKE EXECUTE ON FUNCTION shop.bump() FROM PUBLIC;
      CREATE FUNCTION shop.peek() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS 'SELECT count(*) FROM shop.secret';
      REVOKE EXECUTE ON FUNCTION shop.peek() FROM PUBLIC;
      CREATE FUNCTION shop.plain() RETURNS void LANGUAGE sql AS 'SELECT 1';
    `);
    try {
      // Granted to the role (or a role it is in): refused, with the fix.
      const reasons = await refusedFor('fn_exec', 'GRANT EXECUTE ON FUNCTION shop.bump() TO fn_exec;');
      expect(reasons).toContainEqual({ kind: 'function', role: 'fn_exec', object: 'function shop.bump()' });
      expect(new RefusedError(reasons).message).toContain("fn_exec may run the function shop.bump() with its owner's rights (SECURITY DEFINER)");
      expect(await refusedFor('fn_member', 'CREATE ROLE fn_member_app NOLOGIN; GRANT EXECUTE ON FUNCTION shop.bump() TO fn_member_app; GRANT fn_member_app TO fn_member;')).toContainEqual({
        kind: 'function',
        role: 'fn_member_app',
        object: 'function shop.bump()',
      });
      // STABLE is no safeguard: refused too.
      expect(await refusedFor('fn_stable', 'GRANT EXECUTE ON FUNCTION shop.peek() TO fn_stable;')).toContainEqual({ kind: 'function', role: 'fn_stable', object: 'function shop.peek()' });
      // A function without SECURITY DEFINER runs with the caller's own rights:
      // not a finding, though PUBLIC may run it.
      const quiet = await runAs('maplith_export', { out: tmp(), checkOnly: true });
      expect(quiet.warnings).toEqual([]);
      expect(quiet.lines.some((l) => l.startsWith('Warning'))).toBe(false);
      // Through PUBLIC, whatever the volatility: the run goes on, and says so first.
      await db.exec('GRANT EXECUTE ON FUNCTION shop.bump() TO PUBLIC; GRANT EXECUTE ON FUNCTION shop.peek() TO PUBLIC;');
      const { lines, warnings } = await runAs('maplith_export', { out: tmp(), checkOnly: true });
      expect(warnings).toEqual([
        { kind: 'function', role: 'PUBLIC', object: 'function shop.bump()' },
        { kind: 'function', role: 'PUBLIC', object: 'function shop.peek()' },
      ]);
      expect(lines[0]).toBe(
        "Warning: every role in this database, the extractor's included, may run 2 SECURITY DEFINER functions with their owner's rights: function shop.bump(), function shop.peek(). The extractor never calls them and reads in a read-only transaction. To close it for a role that only reads, see \"If it warns\" in the guide (maplith.com/docs/mcp-template).",
      );
    } finally {
      await db.exec('DROP FUNCTION shop.bump(); DROP FUNCTION shop.peek(); DROP FUNCTION shop.plain();');
    }
  });

  it('a STABLE SECURITY DEFINER function can still write through a VOLATILE one it calls, so it is refused', async () => {
    await db.exec(`
      CREATE TABLE shop.poc (id int, status text);
      INSERT INTO shop.poc VALUES (1, 'open');
      CREATE FUNCTION shop.helper() RETURNS int LANGUAGE plpgsql VOLATILE AS 'BEGIN UPDATE shop.poc SET status = ''pwned''; RETURN 1; END';
      REVOKE EXECUTE ON FUNCTION shop.helper() FROM PUBLIC;
      CREATE FUNCTION shop.stable_sd() RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER AS 'BEGIN RETURN shop.helper(); END';
      REVOKE EXECUTE ON FUNCTION shop.stable_sd() FROM PUBLIC;
      CREATE ROLE poc_ro LOGIN;
      GRANT USAGE ON SCHEMA shop TO poc_ro;
      GRANT EXECUTE ON FUNCTION shop.stable_sd() TO poc_ro;
    `);
    try {
      // The premise the first version rested on is false: the call writes.
      await db.exec('SET SESSION AUTHORIZATION poc_ro');
      await db.query('SELECT shop.stable_sd()');
      await db.exec('SET SESSION AUTHORIZATION postgres; RESET ALL;');
      expect((await query('SELECT status FROM shop.poc'))[0].status).toBe('pwned');
      // So the extractor refuses the role.
      let err: unknown;
      try {
        await runAs('poc_ro', { out: tmp() });
      } catch (e) {
        err = e;
      }
      expect((err as RefusedError).reasons).toContainEqual({ kind: 'function', role: 'poc_ro', object: 'function shop.stable_sd()' });
    } finally {
      await db.exec('SET SESSION AUTHORIZATION postgres; RESET ALL; DROP FUNCTION shop.stable_sd(); DROP FUNCTION shop.helper(); DROP TABLE shop.poc; DROP OWNED BY poc_ro; DROP ROLE poc_ro;');
    }
  });

  it.each([
    ['table', 'GRANT SELECT ON shop.events TO go_table WITH GRANT OPTION;', 'SELECT on shop.events'],
    ['column', 'GRANT SELECT (status) ON shop.orders TO go_column WITH GRANT OPTION;', 'SELECT on shop.orders'],
    ['sequence', 'GRANT SELECT ON SEQUENCE shop.order_no TO go_sequence WITH GRANT OPTION;', 'SELECT on the sequence shop.order_no'],
    ['schema', 'GRANT USAGE ON SCHEMA shop TO go_schema WITH GRANT OPTION;', 'USAGE on the schema shop'],
    ['database', 'GRANT CONNECT ON DATABASE postgres TO go_database WITH GRANT OPTION;', 'CONNECT or TEMPORARY on the database postgres'],
  ])('refuses a grant option: it could hand what it reads to another role (%s)', async (what, grant, object) => {
    const name = `go_${what}`;
    expect(await refusedFor(name, grant)).toContainEqual({ kind: 'grant option', role: name, object });
  });

  it('refuses the admin option on a membership, even of a harmless group', async () => {
    await db.exec('CREATE ROLE harmless_group NOLOGIN;');
    try {
      const reasons = await refusedFor('admin_opt', 'GRANT harmless_group TO admin_opt WITH ADMIN OPTION;');
      expect(reasons).toContainEqual({ kind: 'admin option', role: 'admin_opt', object: 'harmless_group' });
      expect(new RefusedError(reasons).message).toContain('admin_opt may add other roles to harmless_group (WITH ADMIN OPTION)');
    } finally {
      await db.exec('REVOKE harmless_group FROM admin_opt; DROP ROLE harmless_group;');
    }
  });

  it('refuses a grant of SET or ALTER SYSTEM on a server parameter, to the role or a group it is in', async () => {
    try {
      expect(await refusedFor('param_set', 'GRANT SET ON PARAMETER log_statement TO param_set;')).toContainEqual({ kind: 'parameter', role: 'param_set', object: 'log_statement' });
      const reasons = await refusedFor('param_alter', 'CREATE ROLE param_group NOLOGIN; GRANT ALTER SYSTEM ON PARAMETER work_mem TO param_group; GRANT param_group TO param_alter;');
      expect(reasons).toContainEqual({ kind: 'parameter', role: 'param_group', object: 'work_mem' });
      expect(new RefusedError(reasons).message).toContain('param_group may change the server parameter work_mem (GRANT SET or ALTER SYSTEM ON PARAMETER)');
    } finally {
      await db.exec('REVOKE SET ON PARAMETER log_statement FROM param_set; REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM param_group;');
    }
    // The read-only role is untouched by a grant to someone else.
    await runAs('maplith_export', { out: tmp(), checkOnly: true });
  });

  it('refuses owning a publication', async () => {
    await db.exec('CREATE PUBLICATION mx_pub;');
    try {
      expect(await refusedFor('pub_owner', 'ALTER PUBLICATION mx_pub OWNER TO pub_owner;')).toContainEqual({ kind: 'owner', role: 'pub_owner', object: 'publication mx_pub' });
    } finally {
      await db.exec('DROP PUBLICATION mx_pub;');
    }
  });

  it('writes files owner read-write and group read, folders 0750, and never follows a file planted where it writes', async () => {
    const out = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'target.csv'), 'untouched\n');
    mkdirSync(join(out, 'shop'));
    // The name the first version wrote through, now planted as a link.
    symlinkSync(join(outside, 'target.csv'), join(out, 'shop', '.customers.csv'));
    await runAs('maplith_export', { out });
    expect(readFileSync(join(outside, 'target.csv'), 'utf8')).toBe('untouched\n');
    expect(readFileSync(join(out, 'shop/customers.csv'), 'utf8')).toMatch(/^id,email,name,vip,created\n/);
    for (const f of ['shop/customers.csv', 'shop/orders.csv', CATALOG_FILE]) expect(statSync(join(out, f)).mode & 0o037, f).toBe(0);
    const fresh = tmp();
    await runAs('maplith_export', { out: join(fresh, 'new') });
    expect(statSync(join(fresh, 'new')).mode & 0o027).toBe(0);
    expect(statSync(join(fresh, 'new', 'shop')).mode & 0o027).toBe(0);
    // No temporary file is left behind.
    expect(readdirSync(join(fresh, 'new', 'shop')).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('refuses USAGE on a foreign-data wrapper or server, refuses a write to a foreign table, and skips a foreign table it may read', async () => {
    await db.exec(`
      CREATE FOREIGN DATA WRAPPER mx_fdw;
      CREATE SERVER mx_srv FOREIGN DATA WRAPPER mx_fdw;
      CREATE FOREIGN TABLE shop.remote (id int) SERVER mx_srv;
      GRANT SELECT ON shop.remote TO maplith_export;
    `);
    try {
      expect(await refusedFor('fdw_usage', 'GRANT USAGE ON FOREIGN DATA WRAPPER mx_fdw TO fdw_usage;')).toContainEqual({ kind: 'foreign data wrapper', role: 'fdw_usage', object: 'mx_fdw' });
      expect(await refusedFor('srv_usage', 'GRANT USAGE ON FOREIGN SERVER mx_srv TO srv_usage;')).toContainEqual({ kind: 'foreign server', role: 'srv_usage', object: 'mx_srv' });
      expect(await refusedFor('ft_insert', 'GRANT INSERT ON shop.remote TO ft_insert;')).toContainEqual({ kind: 'relation', role: 'ft_insert', object: 'shop.remote' });
      const out = tmp();
      const { lines, catalog } = await runAs('maplith_export', { out });
      expect(lines).toContain('shop.remote: skipped (a foreign table: a read there runs on another server)');
      expect(catalog.tables.map((t) => t.name)).not.toContain('remote');
      expect(listFiles(out)).toEqual(['shop/big_orders.csv', 'shop/customers.csv', 'shop/events.csv', 'shop/maplith-schema.json', 'shop/orders.csv']);
    } finally {
      await db.exec('DROP FOREIGN TABLE shop.remote; DROP SERVER mx_srv; DROP FOREIGN DATA WRAPPER mx_fdw;');
    }
  });

  it.each(['pg_read_all_data', 'pg_write_all_data', 'pg_monitor', 'pg_read_server_files'])('refuses a member of %s', async (predefined) => {
    const name = `member_${predefined}`;
    const reasons = await refusedFor(name, `GRANT ${predefined} TO ${name};`);
    expect(reasons).toContainEqual({ kind: 'predefined role', role: name, object: predefined });
  });

  it.each(['INHERIT TRUE', 'INHERIT FALSE'])('refuses a member of a role that may write (%s)', async (inherit) => {
    const name = `member_${inherit === 'INHERIT TRUE' ? 'inherit' : 'noinherit'}`;
    const writer = `${name}_writer`;
    const reasons = await refusedFor(name, `CREATE ROLE ${writer} NOLOGIN; GRANT INSERT ON shop.orders TO ${writer}; GRANT ${writer} TO ${name} WITH ${inherit};`);
    expect(reasons).toContainEqual({ kind: 'relation', role: writer, object: 'shop.orders' });
  });

  it('refuses a session that logged in as another role and switched to the read-only one', async () => {
    await db.exec('SET ROLE maplith_export');
    let err: unknown;
    try {
      await extract({ query, out: tmp() });
    } catch (e) {
      err = e;
    } finally {
      await db.exec('RESET ROLE; RESET ALL;');
    }
    expect((err as RefusedError).reasons).toContainEqual({ kind: 'login', role: 'postgres', object: 'maplith_export' });
  });

  it('refuses when the transaction is not read-only', async () => {
    const lying: Query = async (sql, params) => {
      const rows = await query(sql, params);
      return sql.includes("current_setting('transaction_read_only')") ? rows.map((r) => ({ ...r, read_only: 'off' })) : rows;
    };
    const out = tmp();
    await expect(runAs('maplith_export', { out }, lying)).rejects.toMatchObject({ reasons: [{ kind: 'transaction', role: '', object: null }] });
    expect(readdirSync(out)).toEqual([]);
  });

  it('takes no SQL: names come from the catalog, quoted, and a hostile name reaches nothing', async () => {
    await db.exec(`
      CREATE TABLE shop."x""; DROP TABLE shop.orders; --" ("a""b" int PRIMARY KEY, "../../etc" text);
      INSERT INTO shop."x""; DROP TABLE shop.orders; --" VALUES (1, 'cellvalue-x');
      GRANT SELECT ON shop."x""; DROP TABLE shop.orders; --" TO maplith_export;
    `);
    try {
      const out = tmp();
      await runAs('maplith_export', { out });
      expect(listFiles(out)).toContain('shop/x___DROP_TABLE_shop_orders__--.csv');
      expect(readFileSync(join(out, 'shop/x___DROP_TABLE_shop_orders__--.csv'), 'utf8')).toBe('"a""b",../../etc\n1,cellvalue-x\n');
      expect((await query('SELECT count(*)::int AS n FROM shop.orders'))[0].n).toBe(5);
    } finally {
      await db.exec(`DROP TABLE shop."x""; DROP TABLE shop.orders; --"`);
    }
    expect(safeName('..')).toBe('__');
    expect(safeName('.hidden')).toBe('_hidden');
    expect(safeName('ordrer_æøå')).toBe('ordrer_æøå');
    expect(() => parseArgs(['--out', 'x', '--query', 'SELECT 1'], {})).toThrow('Unknown argument: --query');
    expect(() => parseArgs(['--max-rows', '0'], { EXPORT_DIR: 'x' })).toThrow();
    expect(parseArgs(['--system', 'bi', '--max-rows', '10', '--statement-timeout', '30', '--deadline', '5', '--check'], { EXPORT_DIR: 'x' })).toEqual({
      out: 'x',
      system: 'bi',
      maxRows: 10,
      statementTimeoutMs: 30_000,
      deadlineMs: 300_000,
      checkOnly: true,
    });
  });

  it('is bounded: a statement timeout on every statement, and a deadline for the run', async () => {
    const seen: [string, unknown[] | undefined][] = [];
    const spy: Query = (sql, params) => {
      seen.push([sql, params]);
      return query(sql, params);
    };
    await runAs('maplith_export', { out: tmp(), statementTimeoutMs: 1234 }, spy);
    expect(seen.find(([sql]) => sql.includes('statement_timeout'))?.[1]).toEqual(['1234']);
    expect(seen.findIndex(([sql]) => sql.includes('statement_timeout'))).toBeLessThan(seen.findIndex(([sql]) => sql.startsWith('BEGIN')));

    let t = 0;
    const out = tmp();
    await expect(runAs('maplith_export', { out, deadlineMs: 1, now: () => (t += 1) })).rejects.toThrow(/deadline/);
    // What was written is whole; nothing half-written, no catalog claiming a run.
    expect(Object.keys(snapshot(out)).every((f) => !f.split('/').pop()!.startsWith('.'))).toBe(true);
    expect(existsSync(join(out, CATALOG_FILE))).toBe(false);
  });

  it('removes only the files of its own tables that are gone, never a file it did not write', async () => {
    const out = tmp();
    mkdirSync(join(out, 'crm'));
    writeFileSync(join(out, 'crm/deals.csv'), 'id\n1\n');
    await runAs('maplith_export', { out });
    await db.exec('REVOKE SELECT ON shop.events FROM maplith_export');
    try {
      const { lines } = await runAs('maplith_export', { out });
      expect(listFiles(out)).toEqual(['crm/deals.csv', 'shop/big_orders.csv', 'shop/customers.csv', 'shop/maplith-schema.json', 'shop/orders.csv']);
      expect(lines).toContain('shop/events.csv: removed (its table is no longer readable)');
      const schema = JSON.parse(readFileSync(join(out, 'shop', SCHEMA_FILE), 'utf8')) as SchemaFile;
      expect(schema.tables.map((t) => t.file)).toEqual(['big_orders.csv', 'customers.csv', 'orders.csv']);
    } finally {
      await db.exec('GRANT SELECT ON shop.events TO maplith_export');
    }
  });

  it('--check verifies the role and reads the catalog without writing a file', async () => {
    const out = tmp();
    const { catalog } = await runAs('maplith_export', { out, checkOnly: true });
    expect(catalog.tables).toHaveLength(4);
    expect(readdirSync(out)).toEqual([]);
  });

  it('puts every table under one system when asked', async () => {
    const out = tmp();
    await runAs('maplith_export', { out, system: 'bi' });
    expect(listFiles(out)).toEqual(['bi/maplith-schema.json', 'bi/shop.big_orders.csv', 'bi/shop.customers.csv', 'bi/shop.events.csv', 'bi/shop.orders.csv']);
    expect(existsSync(join(out, 'bi', CATALOG_FILE))).toBe(true);
    const schema = JSON.parse(readFileSync(join(out, 'bi', SCHEMA_FILE), 'utf8')) as SchemaFile;
    expect(schema.tables.map((t) => t.file)).toEqual(['shop.big_orders.csv', 'shop.customers.csv', 'shop.events.csv', 'shop.orders.csv']);
  });

  it('quotes fields as COPY does', () => {
    expect([null, '', 'a', 'a,b', 'a"b', 'a\nb', '\\.', ' x '].map(csvField)).toEqual(['', '""', 'a', '"a,b"', '"a""b"', '"a\nb"', '"\\."', ' x ']);
  });

  it('a failed ROLLBACK never hides the error that ended the run', async () => {
    const failing: Query = async (sql, params) => {
      if (sql === TABLES_SQL) throw new Error('the original cause');
      if (sql === 'ROLLBACK') throw new Error('Connection terminated');
      return query(sql, params);
    };
    await expect(runAs('maplith_export', { out: tmp() }, failing)).rejects.toThrow('the original cause');
    await db.exec('ROLLBACK').catch(() => {});
  });
});

describe('the credential: never logged, never written, never sent', () => {
  const SECRET = 'pw-SENTINEL-9f2c';
  const URL_SECRET = `postgres://maplith_export:${SECRET}@db.example.com:5432/bi?sslmode=verify-full`;
  const ENVS: Record<string, Record<string, string>> = {
    PGPASSWORD: { PGHOST: 'db.example.com', PGUSER: 'maplith_export', PGPASSWORD: SECRET },
    DATABASE_URL: { DATABASE_URL: URL_SECRET },
  };

  /** A pg-shaped client over the fixture database. `fail` throws a driver-like
   *  error that quotes the credential, as a real driver's message can. */
  function fakePg(fail: null | 'connect' | 'query', seen: Record<string, unknown>[]): PgClientClass {
    return class {
      config: Record<string, unknown>;
      constructor(config: Record<string, unknown>) {
        this.config = config;
        seen.push(config);
      }
      async connect() {
        if (fail === 'connect') throw new Error(`password authentication failed for "${URL_SECRET}" (password ${SECRET})`);
      }
      async query(sql: string, params?: unknown[]) {
        if (fail === 'query' && sql === TABLES_SQL) throw new Error(`server closed the connection; reconnect with ${SECRET}`);
        return { rows: await query(sql, params) };
      }
      async end() {}
    };
  }

  async function cli(envName: string, role: string | null, fail: null | 'connect' | 'query', extra: string[] = []) {
    const out = tmp();
    const lines: string[] = [];
    const seen: Record<string, unknown>[] = [];
    if (role) await db.exec(`SET SESSION AUTHORIZATION ${quoteIdent(role)}`);
    let code: number;
    try {
      code = await runCli(['--out', out, ...extra], ENVS[envName], {
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
        loadClient: async () => fakePg(fail, seen),
      });
    } finally {
      await db.exec('ROLLBACK').catch(() => {});
      await db.exec('SET SESSION AUTHORIZATION postgres; RESET ALL;');
    }
    const files = snapshot(out);
    return { code, lines, files, seen };
  }

  it.each(['PGPASSWORD', 'DATABASE_URL'])('appears in no line, file or catalog: success, --check, refusal, connection and query failure (%s)', async (envName) => {
    const cases = [
      await cli(envName, 'maplith_export', null),
      await cli(envName, 'maplith_export', null, ['--check']),
      await cli(envName, null, null), // the superuser: refused
      await cli(envName, 'maplith_export', 'connect'),
      await cli(envName, 'maplith_export', 'query'),
    ];
    expect(cases.map((c) => c.code)).toEqual([0, 0, 1, 1, 1]);
    expect(cases[0].lines.at(-1)).toMatch(/^OK: wrote 5 files to /);
    expect(cases[1].lines.at(-1)).toBe('OK: the role is read-only and can read 4 tables. Nothing was written.');
    expect(cases[2].lines.join('\n')).toMatch(/^Refusing to run/);
    expect(cases[3].lines.join('\n')).toContain('password authentication failed');
    for (const c of cases) {
      const everything = [...c.lines, ...Object.values(c.files)].join('\n');
      expect(everything).not.toContain(SECRET);
    }
    expect(Object.keys(cases[0].files)).toContain(CATALOG_FILE);
    // The password is handed to the driver and to nothing else: the driver
    // reads PGPASSWORD itself, and DATABASE_URL is its connection string.
    for (const c of cases) for (const config of c.seen) expect(JSON.stringify(config).includes(SECRET)).toBe(envName === 'DATABASE_URL');
  });

  it('hands the driver verified TLS for a DATABASE_URL to another host that names no TLS mode of its own', async () => {
    /** The config runCli builds for the driver, from a client that stops at connect. */
    const configFor = async (env: Record<string, string | undefined>) => {
      const seen: Record<string, unknown>[] = [];
      const Stop = class {
        constructor(config: Record<string, unknown>) {
          seen.push(config);
        }
        async connect() {
          throw new Error('stop here');
        }
        async query() {
          return { rows: [] };
        }
        async end() {}
      };
      expect(await runCli(['--out', tmp(), '--check'], env, { stdout: () => {}, stderr: () => {}, loadClient: async () => Stop })).toBe(1);
      return seen[0];
    };
    const remote = await configFor({ DATABASE_URL: 'postgres://u:p@db.example.com:5432/bi' });
    expect(remote.ssl).toEqual({ rejectUnauthorized: true });
    // That the pinned driver keeps it is checked where the driver is
    // installed: the tests against a real server.
    // This machine, a socket, or a mode the operator chose: left as it is.
    const kept: Record<string, string>[] = [
      { DATABASE_URL: 'postgres://u:p@localhost/bi' },
      { DATABASE_URL: 'postgres://u:p@[::1]:5432/bi' },
      { DATABASE_URL: 'postgres://u:p@/bi?host=/var/run/postgresql' },
      { DATABASE_URL: 'postgres://u:p@db.example.com/bi?sslmode=verify-full' },
      { DATABASE_URL: 'postgres://u:p@db.example.com/bi?ssl=true' },
      { DATABASE_URL: 'postgres://u:p@db.example.com/bi', PGSSLMODE: 'verify-full' },
    ];
    for (const env of kept) {
      expect((await configFor(env)).ssl, env.DATABASE_URL).toBeUndefined();
    }
    expect(urlNeedsTls('not a url')).toBe(true);
    expect(urlNeedsTls('postgresql://u@10.0.0.5/bi')).toBe(true);
    // No host in the URL: the driver takes PGHOST, and so does the TLS rule
    //.
    const noHost = { PGHOST: 'db.remote.example' };
    expect(urlNeedsTls('postgres:///db', noHost)).toBe(true);
    expect(urlNeedsTls('postgres://u:p@/db', noHost)).toBe(true);
    expect(urlNeedsTls('postgres://u:p@/db?host=', noHost)).toBe(true);
    expect(urlNeedsTls('postgres://u:p@db.remote.example/db?host=')).toBe(true);
    expect(urlNeedsTls('postgres:///db')).toBe(false);
    expect(urlNeedsTls('postgres:///db', { PGHOST: '/var/run/postgresql' })).toBe(false);
    expect(urlNeedsTls('postgres:///db', { PGHOST: '127.0.0.1' })).toBe(false);
    expect((await configFor({ DATABASE_URL: 'postgres:///db', PGHOST: 'db.remote.example' })).ssl).toEqual({ rejectUnauthorized: true });
    expect((await configFor({ DATABASE_URL: 'postgres://u:p@/db?host=', PGHOST: 'db.remote.example' })).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('redacts the password, the URL and the password inside it, longest first', () => {
    const secrets = secretsOf({ PGPASSWORD: 'p', DATABASE_URL: 'postgres://u:p%40ss@h/d' });
    expect(secrets).toEqual(['postgres://u:p%40ss@h/d', 'p%40ss', 'p@ss', 'p']);
    expect(redact('a postgres://u:p%40ss@h/d b p@ss', secrets)).toBe('a [redacted] b [redacted]');
  });

  it('connects to the database and to nothing else, and executes nothing it reads', () => {
    const src = readFileSync(join(import.meta.dirname, '../extract-postgres.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['./serve.ts', 'node:crypto', 'node:fs', 'node:path', 'node:url']);
    expect(src).not.toMatch(/\bfetch\(|node:(http|https|net|tls|dns|dgram|child_process|vm|worker_threads)|\beval\(|new Function\(/);
    // The one dynamic import is the driver's.
    expect([...src.matchAll(/await import\(([^)]+)\)/g)].map((m) => m[1])).toEqual(['spec']);
    expect(src).toContain("const spec = 'pg';");
  });
});

describe('one runtime dependency, pinned', () => {
  const kit = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(kit, 'package-lock.json'), 'utf8'));

  it('package.json names the PostgreSQL driver alone, at an exact version, and the lockfile agrees', () => {
    expect(pkg.dependencies).toEqual({ pg: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.type).toBe('module');
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages['node_modules/pg'].version).toBe(pkg.dependencies.pg);
  });

  it('every package in the lockfile comes from the npm registry with an integrity hash, and none has an install script', () => {
    for (const [path, entry] of Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string; hasInstallScript?: boolean }>)) {
      if (path === '') continue;
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
      expect(entry.hasInstallScript, path).toBeUndefined();
    }
  });
});
