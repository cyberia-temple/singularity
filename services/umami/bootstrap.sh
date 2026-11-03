#!/usr/bin/env bash
# Brings Umami up on the prod host and leaves it in a state nobody has to touch:
#
#   1. secrets      ./.env, written once (database password, app secret, 2FA
#                   key, the admin password) and never printed
#   2. containers   docker compose up -d, then wait for the heartbeat
#   3. admin        Umami seeds admin/umami; that password is replaced at once
#                   with the generated one, so the default never faces the
#                   internet for longer than this script runs
#   4. websites     cyberia.church, lain-os.com and chaos.fm, created under the
#                   fixed ids the sites' tags already carry
#   5. certificate  stats.cyberia.church through the webroot, so the existing
#                   `certbot renew` cron keeps it (the wildcard lineage is
#                   renewed by hand and would take this host down with it),
#                   and readable by the group nginx's workers run as
#   6. console      the admin password into Laravel's .env, so /crm/stats can
#                   sign an operator in without anybody typing it
#
# Every step is idempotent: deploy-prod.sh runs this whenever services/umami
# changes, and a re-run changes nothing that is already right.
#
# Usage: bash /root/singularity/services/umami/bootstrap.sh
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
HOST=${UMAMI_HOST:-stats.cyberia.church}
CERTBOT_DIR=${CERTBOT_DIR:-/root/certbot}
LARAVEL_ENV=${LARAVEL_ENV:-$DIR/../../backend/laravel/.env}

# id|domain|name — the ids are also in backend/laravel/config/analytics.php and
# lain-labs/backend's config/services.php.
WEBSITES="4955f251-c9ac-464b-adce-14c8ea75eaf2|cyberia.church|Cyberia
deae2ba0-e146-4884-8615-c4e22a97f811|lain-os.com|Lain OS
c5eeb8dc-7bf2-4b3d-b1e3-1aca8d9686f6|chaos.fm|chaos.fm"

if [ ! -f "$DIR/.env" ]; then
    echo "==> umami: writing secrets"
    (
        umask 077
        {
            echo "UMAMI_DB_PASSWORD=$(openssl rand -hex 24)"
            echo "UMAMI_APP_SECRET=$(openssl rand -hex 32)"
            echo "UMAMI_2FA_KEY=$(openssl rand -hex 32)"
            echo "UMAMI_ADMIN_PASSWORD=$(openssl rand -hex 16)"
        } > "$DIR/.env"
    )
fi

set -a
# shellcheck disable=SC1091
. "$DIR/.env"
set +a

echo "==> umami: containers"
docker compose -f "$DIR/docker-compose.yml" --env-file "$DIR/.env" up -d

up=0
for _ in $(seq 1 90); do
    if docker exec umami curl -fsS http://localhost:3000/api/heartbeat >/dev/null 2>&1; then
        up=1
        break
    fi
    sleep 2
done

if [ "$up" != 1 ]; then
    echo "umami: no heartbeat after three minutes; see docker logs umami" >&2
    exit 1
fi

# A body goes in on stdin, so no password ever sits in a process list.
api() {
    local method=$1 path=$2 token=${3:-}
    local args=(-fsS -X "$method" -H 'Content-Type: application/json')

    if [ -n "$token" ]; then
        args+=(-H "Authorization: Bearer $token")
    fi

    if [ "$method" != GET ]; then
        args+=(--data-binary @-)
    fi

    docker exec -i umami curl "${args[@]}" "http://localhost:3000$path"
}

login() {
    printf '{"username":"admin","password":"%s"}' "$1" \
        | api POST /api/auth/login "" 2>/dev/null \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

token=$(login "$UMAMI_ADMIN_PASSWORD" || true)

if [ -z "$token" ]; then
    seeded=$(login umami || true)

    if [ -z "$seeded" ]; then
        echo "umami: the admin password is neither ours nor the seeded one; leaving the account alone" >&2
        exit 1
    fi

    echo "==> umami: replacing the seeded admin password"
    printf '{"currentPassword":"umami","newPassword":"%s"}' "$UMAMI_ADMIN_PASSWORD" \
        | api POST /api/me/password "$seeded" >/dev/null
    token=$(login "$UMAMI_ADMIN_PASSWORD")
fi

existing=$(api GET '/api/websites?pageSize=200' "$token" < /dev/null)

while IFS='|' read -r id domain name; do
    case "$existing" in
        *"\"$id\""*) continue ;;
    esac

    echo "==> umami: website $domain"
    printf '{"id":"%s","name":"%s","domain":"%s"}' "$id" "$name" "$domain" \
        | api POST /api/websites "$token" >/dev/null
done <<< "$WEBSITES"

if [ ! -s "$CERTBOT_DIR/conf/live/$HOST/fullchain.pem" ]; then
    echo "==> umami: certificate for $HOST"
    # The running proxy already answers the challenge for any *.cyberia.church
    # on :80. A failure is not fatal: nginx reads this certificate per
    # handshake, so only this hostname waits for the next deploy.
    docker run --rm \
        -v "$CERTBOT_DIR/conf:/etc/letsencrypt" \
        -v "$CERTBOT_DIR/www:/var/www/certbot" \
        certbot/certbot certonly --webroot -w /var/www/certbot -d "$HOST" \
        --non-interactive --agree-tos --register-unsafely-without-email \
        || echo "umami: no certificate for $HOST yet" >&2
fi

# nginx reads this certificate per handshake (proxy/stats.conf.template), which
# happens in a worker running as the image's nginx user, not as root. Certbot
# leaves live/ and archive/ 0700 and the key 0600, so this one lineage is opened
# to that group; certbot carries a key's group bits over to its renewal.
NGINX_GID=${NGINX_GID:-101}
if [ -s "$CERTBOT_DIR/conf/live/$HOST/fullchain.pem" ]; then
    for dir in live archive; do
        chgrp "$NGINX_GID" "$CERTBOT_DIR/conf/$dir" "$CERTBOT_DIR/conf/$dir/$HOST"
        chmod g+rx "$CERTBOT_DIR/conf/$dir" "$CERTBOT_DIR/conf/$dir/$HOST"
    done
    chgrp "$NGINX_GID" "$CERTBOT_DIR/conf/archive/$HOST/"*.pem
    chmod g+r "$CERTBOT_DIR/conf/archive/$HOST/"*.pem

    if docker exec proxy test -e /etc/nginx/conf.d/stats.conf 2>/dev/null \
        && ! docker exec -u nginx proxy cat "/etc/letsencrypt/live/$HOST/privkey.pem" >/dev/null 2>&1; then
        echo "umami: nginx workers cannot read the certificate for $HOST" >&2
    fi
fi

if [ -f "$LARAVEL_ENV" ]; then
    if grep -q '^UMAMI_ADMIN_PASSWORD=' "$LARAVEL_ENV"; then
        sed -i "s|^UMAMI_ADMIN_PASSWORD=.*|UMAMI_ADMIN_PASSWORD=$UMAMI_ADMIN_PASSWORD|" "$LARAVEL_ENV"
    else
        printf '\nUMAMI_ADMIN_PASSWORD=%s\n' "$UMAMI_ADMIN_PASSWORD" >> "$LARAVEL_ENV"
    fi
fi

echo "==> umami: ready at https://$HOST"
