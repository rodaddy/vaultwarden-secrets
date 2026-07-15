# Securing the Vaultwarden ADMIN_TOKEN (Argon2)

Vaultwarden's admin panel is gated by `ADMIN_TOKEN`. Stored as **plaintext** it
is a replayable admin credential the moment the config leaks (backup, git,
`docker inspect`, a stray log). Vaultwarden accepts the token as an **Argon2 PHC
hash** instead: you type the plaintext at login, the server verifies it against
the stored hash, and the stored form is no longer the usable secret.

Policy for this infra:
- **Hash** in the server config (env-file / compose).
- **Plaintext** in the vault as `Vaultwarden - admin (<instance>)` (rides the
  vault's encrypted backup) **and** a KBFS break-glass file — because the admin
  token protects the vault itself, so storing it *only* in the vault is circular
  (vault down → no token to fix it).
- No secret value ever goes in chat, logs, or a scratch file.

## Generate the hash

Use the standalone `argon2` CLI (Debian pkg `argon2`). Do **not** use
`vaultwarden hash` — it requires a real TTY and panics on piped stdin.

```sh
# on the vaultwarden host; TOKEN arrives on stdin, hash printed:
SALT=$(openssl rand -base64 24)
printf '%s' "$TOKEN" | argon2 "$SALT" -id -t 3 -m 16 -p 4 -e
# -> $argon2id$v=19$m=65536,t=3,p=4$....   (PHC form vaultwarden wants)
```

Generate a strong token with `openssl rand -base64 40 | tr -d '\n/+=' | cut -c1-48`.

## Placing the hash — the env-file dialect trap

The hash contains multiple `$` (`$argon2id$v=19$m=...`). How `$` and quotes are
treated depends on **how the container reads the file** — and getting it wrong
silently delivers a mangled value that vaultwarden treats as plaintext (login
401, and the `You are using a plain text ADMIN_TOKEN` warning persists).

| Config mechanism | `$` handling | Quotes | Write the value as |
| --- | --- | --- | --- |
| `docker compose` inline `environment:` or `env_file:` | **interpolated** (`$argon2id`→empty) | n/a | escape every `$` as `$$` (`${HASH//\$/\$\$}`); compose collapses `$$`→`$` |
| `docker run --env-file` (e.g. systemd unit) | literal (no interpolation) | **NOT stripped** | **bare**, no quotes, no `$$` |
| shell / systemd `EnvironmentFile=` | literal | stripped | quotes optional; value literal |

The two vaultwarden instances here use different mechanisms:
- **LXC 105** — `docker compose`, `env_file: admin.env` → value written `$$`-escaped.
- **ha-core1** — systemd unit running `docker run --env-file /etc/vaultwarden.env`
  → value written **bare**.

## Verify at the container, not the file

The file being correct does not prove the container got it right (interpolation/
quote handling happens between file and process). Always verify what the
**container** actually holds:

```sh
docker exec vaultwarden printenv ADMIN_TOKEN | grep -qE '^\$argon2id\$v=19' \
  && echo OK || echo MANGLED
```

Then confirm auth end-to-end (200/303 = accepted, 401 = rejected):

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/admin \
  -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "token=$PLAINTEXT"
```

A restart replaces the container, so ignore pre-restart log lines — check
`docker logs vaultwarden --since 60s` for a *current-run* warning only.

## Storing the plaintext

`create_secret`/`update_secret` `fields` is an **array** of
`{name, value, type}` (type 1 = hidden), not an object. Admin tokens go on a
secure note (`type:2`):

```sh
mcp2cli vaultwarden-secrets create_secret --params \
  '{"name":"Vaultwarden - admin (LXC105)","type":2,
    "fields":[{"name":"admin_token","value":"<plaintext>","type":1}]}'
```

Read it back by omitting `field` (the `field` param only accepts `login.*`/
`notes` paths, not custom names) and taking `.result.fields.admin_token`.

Break-glass copy: a `0600` file under
`/keybase/private/rodaddy/vaultwarden-secrets/break-glass/admin-token-<instance>.txt`
on the KBFS host, so the panel is recoverable even if the vault is unreachable.

## Transport safety (why the on-box scripts read stdin)

A `$`-bearing value passed as an **ssh argument** is re-parsed by the remote
shell (`$argon2id` → empty). And a heredoc `ssh host 'bash -s' <<EOF` *is* the
remote stdin, so you cannot also pipe a value in — they collide. The reliable
pattern: stage a small script file on the box, then
`printf '%s\n' "$VALUE" | ssh host '/path/script.sh'` — file is the code, stdin
carries the secret. Use `read -r X || true` (a final line with no trailing
newline makes `read` return non-zero and trips `set -e`).

## Backups

Each run leaves `<config>.pre-argon.bak` next to the edited file for rollback.
