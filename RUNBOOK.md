# Runbook: install Maplith Bridge on a Linux server

For the person who sets the Bridge up. It takes about an hour. At the end, an
MCP client (Maplith, or your own agent) reads a folder of CSV files that a
read-only database role wrote, over HTTPS, with a token only you hand out. No
client ever gets a database password, and you can cut access at any moment.

Would you rather have your AI agent do this, stopping for you at every
decision? See [INSTALL-WITH-YOUR-AGENT.md](INSTALL-WITH-YOUR-AGENT.md).

You need:

- a Linux server in your network that can reach the database, with Node.js 24
  or newer (`node --version`) and npm;
- a database owner or administrator, for step 2;
- a public HTTPS name for the Bridge, such as `bridge.example.com`, with a
  certificate, or a reverse proxy that has one (step 5).

The commands below use these names. Use your own.

| Name | What |
|---|---|
| `/opt/maplith-bridge` | The Bridge, owned by root, read-only to the others. |
| `/srv/maplith/exports` | The folder the extractor writes and the server shares. |
| `/etc/maplith-bridge/token` | The token file. |
| `maplith-extract` | A system user that runs the extractor. Only it holds the database password, and only it writes the folder. |
| `maplith-bridge` | A system user that runs the server, which faces the network. It reads the folder through its group and holds no database password. |

Two users keep the database password away from the process the network can
reach: if the server were ever compromised, the password is not in its
environment, its files or its memory.

## 1. Download, verify and install

Download the release, its checksum and its attestation from
[the releases page](https://github.com/Maplith/agents/releases). Check the
checksum; check that npm, which holds the same file, has the same digest for
it (the two lines must be equal), so a file changed in one place is caught by
the other; and, if you have the GitHub CLI, check the build attestation, which
proves the file was built from this repository by its release workflow:

```sh
VERSION=1.2.0-rc.1
BASE=https://github.com/Maplith/agents/releases/download/v$VERSION
curl -fLO $BASE/maplith-$VERSION.tgz
curl -fLO $BASE/maplith-$VERSION.tgz.sha256
curl -fLO $BASE/maplith-$VERSION.tgz.sigstore.json
sha256sum -c maplith-$VERSION.tgz.sha256
echo "sha512-$(openssl dgst -sha512 -binary maplith-$VERSION.tgz | openssl base64 -A)"
npm view maplith@$VERSION dist.integrity
gh attestation verify maplith-$VERSION.tgz --repo Maplith/agents \
  --bundle maplith-$VERSION.tgz.sigstore.json
```

This repository was called `Maplith/bridge` until version 1.1.0. A release
built before then names that repository in its attestation: verify it with
`--repo Maplith/bridge`.

Then create the users and folders, and install:

```sh
sudo useradd --system --home-dir /var/lib/maplith-extract --create-home --shell /usr/sbin/nologin maplith-extract
sudo useradd --system --no-create-home --shell /usr/sbin/nologin maplith-bridge
sudo mkdir -p /opt/maplith-bridge /srv/maplith/exports /etc/maplith-bridge
sudo tar -xzf maplith-$VERSION.tgz -C /opt/maplith-bridge --strip-components=1
sudo chown -R root:root /opt/maplith-bridge
# The folder: written by maplith-extract, read by the group maplith-bridge,
# nobody else. The setgid bit (the 2) gives every new file and folder the group.
sudo chown maplith-extract:maplith-bridge /srv/maplith/exports
sudo chmod 2750 /srv/maplith/exports
sudo chown maplith-bridge: /etc/maplith-bridge
sudo chmod 700 /etc/maplith-bridge
cd /opt/maplith-bridge && sudo npm ci --ignore-scripts --omit=dev
```

`npm ci` installs the PostgreSQL client, pg 8.23.1, and the packages it needs,
each checked against the hash in `npm-shrinkwrap.json`. No install script runs.
`node /opt/maplith-bridge/bridge.js --version` prints the version.

The extractor writes each file readable by its owner and group only (0640)
and each folder 0750, so the files never become readable to other users.

## 2. Create the read-only role

As a database owner or administrator, with your own names in place of the
angle brackets:

```sql
CREATE ROLE maplith_export LOGIN PASSWORD '<a long random password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE maplith_export SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE <your_database> TO maplith_export;
GRANT USAGE ON SCHEMA <your_schema> TO maplith_export;
-- Table by table: only what may be read.
GRANT SELECT ON <your_schema>.<table_one>, <your_schema>.<table_two> TO maplith_export;
-- Or only some columns of a table.
GRANT SELECT (<column_a>, <column_b>) ON <your_schema>.<table_three> TO maplith_export;
```

Never add `WITH GRANT OPTION`: the extractor refuses a role that may pass its
access on.

On PostgreSQL 14 or older, every role may create tables in the schema
`public` unless that was revoked, and the extractor refuses to run while it
can. Revoke it, after checking that no application relies on it:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Do not give the role `pg_read_all_data`, `GRANT SELECT ON ALL TABLES`, or
default privileges: grant table by table, so a new table is read only when you
add it.

## 3. Fill the folder

Give `maplith-extract` the password in a `~/.pgpass` file only it can read,
typed at a prompt that does not echo it and keeps it out of your shell
history. A `:` or `\` in the password must be written as `\:` or `\\`.

```sh
sudo -u maplith-extract -H bash -c 'umask 077; read -rs -p "Password for maplith_export: " pw; echo;
  printf "%s:%s:%s:%s:%s\n" "<host>" 5432 "<your_database>" maplith_export "$pw" > ~/.pgpass'
```

The PostgreSQL client reads `~/.pgpass` itself, so the password is in no
command line, environment variable or script. Then check the role:

```sh
cd /opt/maplith-bridge
sudo -u maplith-extract -H env PGHOST=<host> PGPORT=5432 PGDATABASE=<your_database> \
  PGUSER=maplith_export PGSSLMODE=verify-full \
  node bridge.js extract postgres --out /srv/maplith/exports --check
```

If the database's certificate comes from your organisation's own certificate
authority, add `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` to the `env` line rather
than weakening `PGSSLMODE`: the PostgreSQL client takes the authority from
there.

`--check` connects, checks the role, lists the tables it would read and writes
nothing. It ends with `OK: the role is read-only and can read <n> tables.` If
it starts with `Refusing to run`, each line names something the role can do
beyond reading, and how to take it away. A line starting with `Warning` names
functions every role in the database may run with their owner's rights.

Then write the files, with the same command without `--check`. It ends with
`OK: wrote <n> files to /srv/maplith/exports.`

Schedule it nightly. With cron, in the crontab of `maplith-extract`
(`sudo crontab -u maplith-extract -e`):

```sh
0 3 * * * cd /opt/maplith-bridge && PGHOST=<host> PGPORT=5432 PGDATABASE=<your_database> PGUSER=maplith_export PGSSLMODE=verify-full node bridge.js extract postgres --out /srv/maplith/exports
```

Or with a systemd timer: give the service `User=maplith-extract`, and, to keep
the password file outside the user's home, `LoadCredential=pgpass:/etc/maplith-extract/pgpass`
with `Environment=PGPASSFILE=%d/pgpass`.

## 4. Create the token

```sh
cd /opt/maplith-bridge
sudo -u maplith-bridge node bridge.js rotate-token --token-file /etc/maplith-bridge/token
```

It writes a random 256-bit token to the file, readable by `maplith-bridge`
only, and prints where it is, never the token itself. The Bridge takes only a
token in this shape: do not write one by hand.

It also prints one line, as `serve` does when it starts:

```text
Security notices and release news: https://maplith.com/bridge/updates
```

The Bridge never calls home: it sends no telemetry and checks for no updates.
To hear about a security fix, sign up on that page with your own address, if
you want to. It is optional, and every email has a link to stop.

## 5. Serve it behind TLS

A client on the internet reads over HTTPS only. Choose one of the two.

**A. HTTPS in the Bridge.** Give it the certificate and key for your name. The
key must be readable by `maplith-bridge` only (`chmod 600`) and lie outside
the served folder; the Bridge refuses it otherwise.

```sh
node bridge.js serve --dir /srv/maplith/exports --token-file /etc/maplith-bridge/token \
  --host 0.0.0.0 --port 8443 \
  --tls-cert /etc/maplith-bridge/cert.pem --tls-key /etc/maplith-bridge/key.pem
```

Its address is then `https://bridge.example.com:8443/mcp`. The Bridge reads
the certificate when it starts: restart it after you renew the certificate.

**B. A reverse proxy in front.** The Bridge listens on this machine only, and
the proxy ends TLS. With Caddy, which gets and renews the certificate itself:

```
bridge.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

```sh
node bridge.js serve --dir /srv/maplith/exports --token-file /etc/maplith-bridge/token \
  --host 127.0.0.1 --port 8787 --behind-proxy 127.0.0.1
```

`--behind-proxy 127.0.0.1` names the proxy: the Bridge then takes requests
from it only, and counts wrong tokens by the caller address the proxy
forwards (`X-Forwarded-For`), not by the proxy's own. With nginx, set
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. If the proxy
runs on another host, name its addresses instead (a range no wider than /12
for IPv4 or /29 for IPv6), and keep the Bridge's port closed to everything
else. `--behind-proxy any` is accepted only with `--host 127.0.0.1`.

The Bridge refuses to listen beyond this machine in plain HTTP unless one of
the two is set.

**Run it as a service.** A systemd unit for option B (for option A, use the
command from A in `ExecStart`):

```ini
[Unit]
Description=Maplith Bridge
After=network-online.target
Wants=network-online.target

[Service]
User=maplith-bridge
Group=maplith-bridge
WorkingDirectory=/opt/maplith-bridge
ExecStart=/usr/bin/node /opt/maplith-bridge/bridge.js serve --dir /srv/maplith/exports --token-file /etc/maplith-bridge/token --host 127.0.0.1 --port 8787 --behind-proxy 127.0.0.1
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

`ProtectSystem=strict` makes the whole file system read-only for the Bridge,
which writes nothing. When it starts, it prints its address and how to connect
a client, never the token (`journalctl -u maplith-bridge`). A health check can
use `GET /healthz`, which answers 204 with no body and needs no token.

**Check it.** Never copy the token to another machine to test it.

- From outside your network, without the token: the answer must be `401`.
  That proves the name, the certificate and the route.

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://bridge.example.com/mcp \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
  ```

- On the Bridge's own host, with the token, read from its file by a shell
  builtin so it appears in no command line (do not add `-v` or `--trace`:
  they print the token with the request headers):

  ```sh
  sudo -u maplith-bridge bash -c 'printf "Authorization: Bearer %s\n" "$(< /etc/maplith-bridge/token)" |
    curl -s -X POST http://127.0.0.1:8787/mcp -H @- -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"resources/list\"}"'
  ```

  With option A, use `https://127.0.0.1:8443/mcp` and add `-k` (the
  certificate names your host, not 127.0.0.1). The answer lists your files as
  `exports://<schema>/<table>.csv`, and one `exports://<schema>/maplith-schema.json`
  per folder: the tables' columns, attribute numbers, types and keys, no values.

**Optional: an allow-list.** `--allow <addresses>` serves only callers from
those IP addresses or ranges.

## 6. Connect a client

Give the client the HTTPS address ending in `/mcp` and the token from
`/etc/maplith-bridge/token`. Type the token into the client's own settings,
never into a chat with an assistant.

- **Maplith:** open **Integrations**, choose **Add MCP connection**, paste the
  address as the **MCP URL** and type the token as the **Bearer token**. **Test
  connection** shows how many files the Bridge lists. To follow the nightly
  extract, set the map to rebuild every day under **Settings**.
- **Claude Code:** `claude mcp add --transport http bridge https://bridge.example.com/mcp --header "Authorization: Bearer <token>"`.
- **Any other MCP client:** the same address, with the header
  `Authorization: Bearer <token>`.

## 7. Rotate the token

When someone who saw the token leaves, or on your own schedule:

```sh
sudo -u maplith-bridge node /opt/maplith-bridge/bridge.js rotate-token --token-file /etc/maplith-bridge/token
```

The running Bridge takes the new token on its next request and refuses the
old one from then on: no restart. Then give every client the new token.

## 8. Upgrade

Download and verify the new release as in step 1, then replace the files and
restart:

```sh
sudo rm -rf /opt/maplith-bridge && sudo mkdir /opt/maplith-bridge
sudo tar -xzf maplith-$VERSION.tgz -C /opt/maplith-bridge --strip-components=1
sudo chown -R root:root /opt/maplith-bridge
cd /opt/maplith-bridge && sudo npm ci --ignore-scripts --omit=dev
sudo systemctl restart maplith-bridge
```

The token file, the folder and the database role stay as they are. Read
[CHANGELOG.md](CHANGELOG.md) first. To be told when a release fixes a
security issue, sign up at https://maplith.com/bridge/updates (step 4).

## Logs, and what to watch

The Bridge prints one line when it starts, and one line each time an address
reaches 10 wrong tokens within 10 minutes:

```
2026-10-13T09:12:01.000Z 203.0.113.9: 10 failed token attempts within 10 minutes; wrong tokens get 429 for 15 minutes.
```

The right token is always served, also from that address: the limit cannot
lock out a client that has the token. Several of those lines in a day mean
someone is guessing. Guessing a 256-bit token is not feasible, but rotate it if
you are in doubt, and look at who reaches the port. If the token file changes
into something the Bridge cannot use (other users may read it, it is not a
regular file, the token is weak), it logs why and refuses every request until
it is fixed.

The extractor prints one line per table and ends with `OK:`, or one error
message and exit code 1. Neither ever prints the token or the database
password.

## Stop or remove it

- **Stop all reading at once:** stop the service, or rotate the token.
- **Read less:** revoke a table's SELECT from `maplith_export`. The next
  extract removes its file.
- **Remove the role:** `DROP OWNED BY maplith_export; DROP ROLE maplith_export;`
  (the first part in each database you granted access in).
- **Remove the Bridge:** stop and disable the service, then delete
  `/opt/maplith-bridge`, `/srv/maplith/exports`, `/etc/maplith-bridge` and the
  two users.

Questions: support@maplith.com. Security reports: see
[SECURITY.md](SECURITY.md).
