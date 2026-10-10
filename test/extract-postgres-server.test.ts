import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { RefusedError, extract, runCli, type PgClient, type PgClientClass } from '../extract-postgres.ts';

/** The extractor against a real PostgreSQL server, not PGlite: the
 *  refusals and the determinism of the PGlite tests, run through the command
 *  line a person runs (runCli), with the pinned driver it loads itself, over
 *  a real login with a password (SCRAM), one role per case.
 *
 *  It runs only when MAPLITH_PG_TEST_URL names a superuser connection, as CI
 *  does for PostgreSQL 14 (the oldest that grants CREATE on schema public to
 *  PUBLIC by default) and for the current major. MAPLITH_PG_TEST_MAJOR, when
 *  set, must be the server's major version, so the matrix cannot test the
 *  wrong one. It needs the driver installed beside the extractor
 *  (`npm ci --ignore-scripts` where package.json is). It drops and
 *  recreates the database maplith_extract_it and the roles named mx_*, so
 *  point it at a throwaway server only. */

const ADMIN_URL = process.env.MAPLITH_PG_TEST_URL;
const DB = 'maplith_extract_it';

const kit = new URL('../', import.meta.url).pathname;
const loadDriver = (): PgClientClass => {
  const pg = createRequire(join(kit, 'package.json'))('pg') as { Client: PgClientClass };
  return pg.Client;
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pg-real-'));
  dirs.push(d);
  return d;
};
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
const csvOnly = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).filter(([f]) => f.endsWith('.csv')));
/** Every file under `dir`, byte for byte. */
const bytes = (dir: string) => Object.fromEntries(Object.keys(snapshot(dir)).map((f) => [f, readFileSync(join(dir, f)).toString('hex')]));

/** Two tables with every kind of value whose text form a session setting
 *  could change, edge values included, and one with no key, duplicate rows
 *  and types that have no ordering of their own. The same fixture runs in PGlite
 *  in extract-postgres.test.ts. */
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

describe.skipIf(!ADMIN_URL)('the extractor against a real PostgreSQL server', () => {
  const admin = new URL(ADMIN_URL ?? 'postgres://localhost/postgres');
  let su: PgClient; // the superuser, in the test database
  let version = 0;
  const passwords = new Map<string, string>();
  const sql = async (text: string) => (await su.query(text)).rows;

  /** A login role with a fresh password; `setup` runs as the superuser after it exists. */
  async function role(name: string, setup = '', attrs = '') {
    const pw = `mx-${randomBytes(12).toString('hex')}`;
    passwords.set(name, pw);
    await sql(`CREATE ROLE ${name} LOGIN PASSWORD '${pw}' ${attrs}`);
    await sql(`GRANT USAGE ON SCHEMA shop TO ${name}; GRANT SELECT ON shop.orders TO ${name};`);
    if (setup) await sql(setup);
  }

  /** The command line, as a person runs it, logged in as `name`. The
   *  driver reads the PG* variables from the process's own environment, as it
   *  does in real use, so they are set there for the one run. */
  async function cli(name: string, args: string[] = [], env: Record<string, string | undefined> = {}) {
    const out = tmp();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const password = passwords.get(name) ?? '';
    const vars: Record<string, string | undefined> = {
      PGHOST: admin.hostname,
      PGPORT: admin.port || '5432',
      PGDATABASE: DB,
      PGUSER: name,
      PGPASSWORD: password,
      PGSSLMODE: undefined,
      DATABASE_URL: undefined,
      ...env,
    };
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    const put = (from: Record<string, string | undefined>) => {
      for (const [k, v] of Object.entries(from)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    put(vars);
    let code: number;
    try {
      code = await runCli(['--out', out, ...args], process.env, { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
    } finally {
      put(saved);
    }
    const files = snapshot(out);
    const all = [...stdout, ...stderr, ...Object.values(files)].join('\n');
    expect(all).not.toContain(password);
    return { code, stdout, stderr, files, out };
  }

  /** Refused, before a file was written, with this line among the reasons. */
  async function refused(name: string, line: string) {
    const r = await cli(name);
    expect(r.code).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/^Refusing to run: the role can do more than read/);
    expect(r.stderr.join('\n')).toContain(line);
    expect(r.files).toEqual({});
  }

  beforeAll(async () => {
    const Client = loadDriver();
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    try {
      version = Number((await root.query("SELECT current_setting('server_version_num') AS v")).rows[0].v);
      await root.query(`DROP DATABASE IF EXISTS ${DB}`);
      for (const r of (await root.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'mx\\_%'")).rows) await root.query(`DROP ROLE "${String(r.rolname)}"`);
      await root.query(`CREATE DATABASE ${DB}`);
    } finally {
      await root.end();
    }
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${DB}`;
    su = new Client({ connectionString: url.toString() });
    await su.connect();
    await sql(`
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
    `);
    // The read-only role of the guide, step 2.
    await role('mx_export', `ALTER ROLE mx_export SET default_transaction_read_only = on;
      GRANT CONNECT ON DATABASE ${DB} TO mx_export;
      GRANT SELECT (id, email, name, vip, created) ON shop.customers TO mx_export;
      GRANT SELECT ON shop.events, shop.big_orders TO mx_export;`, 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  }, 60_000);

  afterAll(async () => {
    await su?.end();
  });

  it('runs against the major version the job names', () => {
    expect(version).toBeGreaterThanOrEqual(140000);
    if (process.env.MAPLITH_PG_TEST_MAJOR) expect(Math.floor(version / 10000)).toBe(Number(process.env.MAPLITH_PG_TEST_MAJOR));
  });

  it('on PostgreSQL 14, refuses every role until CREATE on schema public is revoked from PUBLIC; from 15 it is not granted', async () => {
    if (version < 150000) {
      await refused('mx_export', 'mx_export may create objects in, or owns, the schema public (on PostgreSQL 14 or older: REVOKE CREATE ON SCHEMA public FROM PUBLIC)');
    }
    await sql('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    const r = await cli('mx_export', ['--check']);
    expect(r.code).toBe(0);
    expect(r.stdout.at(-1)).toBe('OK: the role is read-only and can read 4 tables. Nothing was written.');
  });

  describe('determinism', () => {
    it('writes the cells as COPY does, and two runs write the same bytes', async () => {
      const a = await cli('mx_export');
      const b = await cli('mx_export');
      expect(a.code).toBe(0);
      expect(a.stdout.at(-1)).toMatch(/^OK: wrote 4 files to /);
      expect(Object.keys(a.files).sort()).toEqual(['.maplith-extract.json', 'shop/big_orders.csv', 'shop/customers.csv', 'shop/events.csv', 'shop/orders.csv']);
      expect(a.files).toEqual(b.files);
      expect(a.files['shop/customers.csv']).toBe(
        [
          'id,email,name,vip,created',
          '1,alice.cellvalue@example.com,Alice Cellvalue,t,2026-01-02 01:04:05+00',
          '2,bob.cellvalue@example.com,"Bob, ""the"" Cellvalue",f,2026-02-03 04:05:06+00',
          '3,,"",,',
          '4,dora.cellvalue@example.com,"Dora\nCellvalue",t,2026-03-04 05:06:07+00',
          '',
        ].join('\n'),
      );
      expect(a.files['shop/events.csv']).toBe(
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
      expect(a.files['.maplith-extract.json']).not.toMatch(/cellvalue/i);
      expect(a.stdout.join('\n')).not.toMatch(/cellvalue/i);
    });

    it('a cut table is the same prefix every time, and a fresh ANALYZE moves no byte of a CSV', async () => {
      const a = await cli('mx_export', ['--max-rows', '3']);
      await sql('ANALYZE');
      const b = await cli('mx_export', ['--max-rows', '3']);
      expect(csvOnly(a.files)).toEqual(csvOnly(b.files));
      expect(a.files['shop/orders.csv'].split('\n')[0]).toBe('Maplith extract: the first 3 rows of shop.orders in primary key order - not the whole table');
    });

    it('two separate runs write the same bytes, catalog included, whatever the role\'s settings and the rows\' order on disk', async () => {
      await sql(DETERMINISM_FIXTURE);
      await role('mx_det', `GRANT CONNECT ON DATABASE ${DB} TO mx_det; GRANT USAGE ON SCHEMA det TO mx_det; GRANT SELECT ON det.wide, det.loose TO mx_det;`, 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
      const a = await cli('mx_det');
      expect(a.code).toBe(0);
      // The rows moved on disk (an UPDATE writes a row's new version at the
      // end), and every setting a value's text form depends on set otherwise
      // for the role, and by the client for the session.
      await sql(`UPDATE det.wide SET t = t WHERE id = 1; UPDATE det.loose SET b = b WHERE a = 'x';`);
      for (const setting of ["TimeZone = 'Pacific/Chatham'", "DateStyle = 'SQL, DMY'", "IntervalStyle = 'sql_standard'", 'extra_float_digits = -15', "bytea_output = 'escape'", "lc_monetary = 'C'", 'search_path = det, public']) {
        await sql(`ALTER ROLE mx_det SET ${setting}`);
      }
      const b = await cli('mx_det', [], { PGOPTIONS: '-c TimeZone=Asia/Kathmandu' });
      expect(b.code).toBe(0);
      expect(Object.keys(a.files).sort()).toEqual(['.maplith-extract.json', 'det/loose.csv', 'det/wide.csv', 'shop/orders.csv']);
      expect(bytes(b.out)).toEqual(bytes(a.out));
      expect(a.files['det/wide.csv']).toContain(',2026-03-29 00:30:00+00,');
      expect(a.files['det/wide.csv']).toContain(',\\xdeadbeef,');
      expect(a.files['det/wide.csv']).toContain(',"$1,234.56",');
    });
  });

  describe('what the extractor must never do, one login role per case', () => {
    const tablePrivileges = () => ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', ...(version >= 170000 ? ['MAINTAIN'] : [])];

    it('refuses the superuser and every role attribute that is more than reading', async () => {
      await role('mx_super', '', 'SUPERUSER');
      await refused('mx_super', 'mx_super has the attribute SUPERUSER');
      for (const attr of ['CREATEROLE', 'CREATEDB', 'BYPASSRLS', 'REPLICATION']) {
        const name = `mx_attr_${attr.toLowerCase()}`;
        await role(name, '', attr);
        await refused(name, `${name} has the attribute ${attr}`);
      }
    }, 60_000);

    it('refuses every privilege beyond SELECT on a table or a column', async () => {
      for (const p of tablePrivileges()) {
        const name = `mx_priv_${p.toLowerCase()}`;
        await role(name, `GRANT ${p} ON shop.events TO ${name};`);
        await refused(name, `${name} may change shop.events (a privilege beyond SELECT)`);
      }
      await role('mx_priv_column', 'GRANT UPDATE (status) ON shop.orders TO mx_priv_column;');
      await refused('mx_priv_column', 'mx_priv_column may change shop.orders');
    }, 60_000);

    it('refuses a sequence it may advance, an object it owns, CREATE on a schema or the database', async () => {
      await role('mx_seq', 'GRANT USAGE ON SEQUENCE shop.order_no TO mx_seq;');
      await refused('mx_seq', 'mx_seq may advance or set the sequence shop.order_no');
      await role('mx_owner', 'CREATE TABLE shop.owned (x int); ALTER TABLE shop.owned OWNER TO mx_owner;');
      await refused('mx_owner', 'mx_owner owns shop.owned');
      await sql('DROP TABLE shop.owned');
      await role('mx_schema', 'GRANT CREATE ON SCHEMA shop TO mx_schema;');
      await refused('mx_schema', 'mx_schema may create objects in, or owns, the schema shop');
      await role('mx_db', `GRANT CREATE ON DATABASE ${DB} TO mx_db;`);
      await refused('mx_db', `mx_db may create schemas in, or owns, the database ${DB}`);
    }, 60_000);

    it('refuses a member of a predefined role, or of a role that may write, inherited or not', async () => {
      for (const predefined of ['pg_read_all_data', 'pg_write_all_data', 'pg_monitor', 'pg_read_server_files']) {
        const name = `mx_member_${predefined.slice(3)}`;
        await role(name, `GRANT ${predefined} TO ${name};`);
        await refused(name, `the role is a member of ${predefined}`);
      }
      await role('mx_writer_member', 'CREATE ROLE mx_writer NOLOGIN; GRANT INSERT ON shop.orders TO mx_writer; GRANT mx_writer TO mx_writer_member;');
      await refused('mx_writer_member', 'mx_writer may change shop.orders');
      await role('mx_noinherit', 'GRANT mx_writer TO mx_noinherit;', 'NOINHERIT');
      await refused('mx_noinherit', 'mx_writer may change shop.orders');
    }, 60_000);

    it('refuses a session that logged in as another role and switched to the read-only one', async () => {
      await sql('SET ROLE mx_export');
      let err: unknown;
      try {
        await extract({ query: async (text, params) => (await su.query(text, params)).rows, out: tmp() });
      } catch (e) {
        err = e;
      } finally {
        await sql('ROLLBACK').catch(() => {});
        await sql('RESET ROLE; RESET ALL;');
      }
      expect(err).toBeInstanceOf(RefusedError);
      expect((err as RefusedError).reasons).toContainEqual({ kind: 'login', role: admin.username || 'postgres', object: 'mx_export' });
    });

    it('refuses write access to a large object through its access list, and lo_compat_privileges', async () => {
      const [{ oid }] = await sql('SELECT lo_create(0)::text AS oid');
      try {
        await role('mx_lo', `GRANT UPDATE ON LARGE OBJECT ${oid} TO mx_lo;`);
        await refused('mx_lo', `mx_lo may write the large object ${oid} (UPDATE in its access list)`);
        await sql(`GRANT SELECT ON LARGE OBJECT ${oid} TO mx_export`);
        expect((await cli('mx_export', ['--check'])).code).toBe(0);
        await sql(`GRANT UPDATE ON LARGE OBJECT ${oid} TO PUBLIC`);
        await refused('mx_export', `mx_export may write the large object ${oid}`);
      } finally {
        await sql(`SELECT lo_unlink(${oid})`);
      }
      await role('mx_lo_compat', 'ALTER ROLE mx_lo_compat SET lo_compat_privileges = on;');
      await refused('mx_lo_compat', 'lo_compat_privileges is on: every role may write every large object');
    }, 60_000);

    it('refuses EXECUTE granted on any SECURITY DEFINER function, STABLE included, and warns when it comes through PUBLIC', async () => {
      await sql(`
        CREATE TABLE shop.poc (id int, status text);
        INSERT INTO shop.poc VALUES (1, 'open');
        CREATE FUNCTION shop.bump() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'UPDATE shop.orders SET status = status';
        REVOKE EXECUTE ON FUNCTION shop.bump() FROM PUBLIC;
        CREATE FUNCTION shop.helper() RETURNS int LANGUAGE plpgsql VOLATILE AS 'BEGIN UPDATE shop.poc SET status = ''pwned''; RETURN 1; END';
        REVOKE EXECUTE ON FUNCTION shop.helper() FROM PUBLIC;
        CREATE FUNCTION shop.stable_sd() RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER AS 'BEGIN RETURN shop.helper(); END';
        REVOKE EXECUTE ON FUNCTION shop.stable_sd() FROM PUBLIC;
      `);
      try {
        await role('mx_fn', 'GRANT EXECUTE ON FUNCTION shop.bump() TO mx_fn;');
        await refused('mx_fn', "mx_fn may run the function shop.bump() with its owner's rights (SECURITY DEFINER)");
        await role('mx_fn_stable', 'GRANT EXECUTE ON FUNCTION shop.stable_sd() TO mx_fn_stable;');
        await refused('mx_fn_stable', "mx_fn_stable may run the function shop.stable_sd() with its owner's rights (SECURITY DEFINER)");
        // The review's PoC on a real server: the STABLE function writes.
        const Client = loadDriver();
        const c = new Client({ host: admin.hostname, port: Number(admin.port || 5432), database: DB, user: 'mx_fn_stable', password: passwords.get('mx_fn_stable') });
        await c.connect();
        try {
          await c.query('SELECT shop.stable_sd()');
        } finally {
          await c.end();
        }
        expect((await sql('SELECT status FROM shop.poc'))[0].status).toBe('pwned');
        const quiet = await cli('mx_export', ['--check']);
        expect(quiet.code).toBe(0);
        expect(quiet.stdout.some((l) => l.startsWith('Warning'))).toBe(false);
        await sql('GRANT EXECUTE ON FUNCTION shop.bump() TO PUBLIC; GRANT EXECUTE ON FUNCTION shop.stable_sd() TO PUBLIC;');
        const warned = await cli('mx_export', ['--check']);
        expect(warned.code).toBe(0);
        expect(warned.stdout[0]).toMatch(/^Warning: every role in this database, the extractor's included, may run 2 SECURITY DEFINER functions with their owner's rights: function shop\.bump\(\), function shop\.stable_sd\(\)\./);
      } finally {
        await sql('DROP FUNCTION shop.bump(); DROP FUNCTION shop.stable_sd(); DROP FUNCTION shop.helper(); DROP TABLE shop.poc;');
      }
    }, 60_000);

    it('refuses a grant of SET or ALTER SYSTEM on a server parameter, from PostgreSQL 15', async () => {
      // PostgreSQL 14 has no pg_parameter_acl: there is nothing to grant.
      if (version < 150000) return;
      await role('mx_param_set', 'GRANT SET ON PARAMETER log_statement TO mx_param_set;');
      await refused('mx_param_set', 'mx_param_set may change the server parameter log_statement (GRANT SET or ALTER SYSTEM ON PARAMETER)');
      await role('mx_param_alter', 'GRANT ALTER SYSTEM ON PARAMETER work_mem TO mx_param_alter;');
      await refused('mx_param_alter', 'mx_param_alter may change the server parameter work_mem');
      await sql('REVOKE SET ON PARAMETER log_statement FROM mx_param_set; REVOKE ALTER SYSTEM ON PARAMETER work_mem FROM mx_param_alter;');
      expect((await cli('mx_export', ['--check'])).code).toBe(0);
    }, 60_000);

    it('refuses grant options, the admin option and owning a publication', async () => {
      for (const [what, grant, line] of [
        ['table', 'GRANT SELECT ON shop.events TO mx_go_table WITH GRANT OPTION;', 'mx_go_table may grant SELECT on shop.events to other roles (WITH GRANT OPTION)'],
        ['column', 'GRANT SELECT (status) ON shop.orders TO mx_go_column WITH GRANT OPTION;', 'mx_go_column may grant SELECT on shop.orders to other roles'],
        ['sequence', 'GRANT SELECT ON SEQUENCE shop.order_no TO mx_go_sequence WITH GRANT OPTION;', 'mx_go_sequence may grant SELECT on the sequence shop.order_no'],
        ['schema', 'GRANT USAGE ON SCHEMA shop TO mx_go_schema WITH GRANT OPTION;', 'mx_go_schema may grant USAGE on the schema shop'],
      ]) {
        await role(`mx_go_${what}`, grant);
        await refused(`mx_go_${what}`, line);
      }
      await role('mx_admin_opt', 'CREATE ROLE mx_harmless NOLOGIN; GRANT mx_harmless TO mx_admin_opt WITH ADMIN OPTION;');
      await refused('mx_admin_opt', 'mx_admin_opt may add other roles to mx_harmless (WITH ADMIN OPTION)');
      await role('mx_pub_owner', 'CREATE PUBLICATION mx_pub; ALTER PUBLICATION mx_pub OWNER TO mx_pub_owner;');
      try {
        await refused('mx_pub_owner', 'mx_pub_owner owns publication mx_pub');
      } finally {
        await sql('DROP PUBLICATION mx_pub;');
      }
    }, 60_000);

    it('refuses USAGE on a foreign-data wrapper or server, and skips a foreign table', async () => {
      await sql(`
        CREATE FOREIGN DATA WRAPPER mx_fdw;
        CREATE SERVER mx_srv FOREIGN DATA WRAPPER mx_fdw;
        CREATE FOREIGN TABLE shop.remote (id int) SERVER mx_srv;
        GRANT SELECT ON shop.remote TO mx_export;
      `);
      try {
        await role('mx_fdw_usage', 'GRANT USAGE ON FOREIGN DATA WRAPPER mx_fdw TO mx_fdw_usage;');
        await refused('mx_fdw_usage', 'mx_fdw_usage may use the foreign-data wrapper mx_fdw');
        await role('mx_srv_usage', 'GRANT USAGE ON FOREIGN SERVER mx_srv TO mx_srv_usage;');
        await refused('mx_srv_usage', 'mx_srv_usage may use the foreign server mx_srv');
        const r = await cli('mx_export');
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('shop.remote: skipped (a foreign table: a read there runs on another server)');
        expect(Object.keys(r.files)).not.toContain('shop/remote.csv');
      } finally {
        await sql('DROP FOREIGN TABLE shop.remote; DROP SERVER mx_srv; DROP FOREIGN DATA WRAPPER mx_fdw;');
      }
    }, 60_000);
  });

  describe('the credential', () => {
    it('the pinned driver keeps the verified TLS the command line sets for a remote DATABASE_URL', async () => {
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
      const code = await runCli(['--out', tmp(), '--check'], { DATABASE_URL: 'postgres://u:p@db.example.com:5432/bi' }, { stdout: () => {}, stderr: () => {}, loadClient: async () => Stop });
      expect(code).toBe(1);
      const ConnectionParameters = createRequire(join(kit, 'package.json'))('pg/lib/connection-parameters') as new (c: Record<string, unknown>) => { ssl: unknown };
      expect(new ConnectionParameters(seen[0]).ssl).toEqual({ rejectUnauthorized: true });
      // Without the default, the driver would have used no TLS at all.
      expect(new ConnectionParameters({ connectionString: 'postgres://u:p@db.example.com:5432/bi' }).ssl).toBeFalsy();
    });

    it('a wrong password is refused by the server and never printed', async () => {
      const r = await cli('mx_export', ['--check'], { PGPASSWORD: 'wrong-SENTINEL-pw' });
      expect(r.code).toBe(1);
      expect(r.stderr.join('\n')).toContain('password authentication failed');
      expect(r.stderr.join('\n')).not.toContain('wrong-SENTINEL-pw');
    });

    it('DATABASE_URL works the same, and is never printed', async () => {
      const pw = passwords.get('mx_export')!;
      const url = `postgres://mx_export:${encodeURIComponent(pw)}@${admin.hostname}:${admin.port || '5432'}/${DB}`;
      const r = await cli('mx_export', ['--check'], { DATABASE_URL: url, PGPASSWORD: undefined });
      expect(r.code).toBe(0);
      expect([...r.stdout, ...r.stderr].join('\n')).not.toContain(url);
    });
  });
});
