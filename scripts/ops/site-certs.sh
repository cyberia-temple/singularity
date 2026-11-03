#!/usr/bin/env bash
# Webroot certificates for the static *.cyberia.church sites (docs, blog).
#
# These used to borrow the wildcard lineage, which only DNS-01 can renew and
# Namecheap gives certbot no API for, so it is renewed by hand — and when it
# lapsed on 2026-10-26 it took docs (and every deploy's final check) with it.
# Each site now gets its own HTTP-01 certificate that the `certbot renew` cron
# keeps fresh. Idempotent and never fatal: an existing lineage is left alone,
# and nginx reads these per handshake ($ssl_server_name), so a missing one costs
# only its own hostname.
#
# Runs on the prod host from deploy-prod.sh. Usage: site-certs.sh host...
set -uo pipefail

CERTBOT_DIR=${CERTBOT_DIR:-/root/certbot}
NGINX_GID=${NGINX_GID:-101}

for host in "$@"; do
    if [ ! -s "$CERTBOT_DIR/conf/live/$host/fullchain.pem" ]; then
        echo "==> certificate for $host"
        # The running proxy answers the ACME challenge on :80 for these names.
        docker run --rm \
            -v "$CERTBOT_DIR/conf:/etc/letsencrypt" \
            -v "$CERTBOT_DIR/www:/var/www/certbot" \
            certbot/certbot certonly --webroot -w /var/www/certbot -d "$host" \
            --non-interactive --agree-tos --register-unsafely-without-email \
            || { echo "no certificate for $host yet" >&2; continue; }
    fi
    # Per-handshake reads happen in nginx workers (not root); certbot leaves
    # live/ and archive/ 0700 and keys 0600, and carries group bits into renewals.
    for dir in live archive; do
        chgrp "$NGINX_GID" "$CERTBOT_DIR/conf/$dir" "$CERTBOT_DIR/conf/$dir/$host"
        chmod g+rx "$CERTBOT_DIR/conf/$dir" "$CERTBOT_DIR/conf/$dir/$host"
    done
    chgrp "$NGINX_GID" "$CERTBOT_DIR/conf/archive/$host/"*.pem
    chmod g+r "$CERTBOT_DIR/conf/archive/$host/"*.pem
done
exit 0
