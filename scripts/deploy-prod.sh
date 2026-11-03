#!/usr/bin/env bash
# Prod deploy for the Laravel app (cyberia.church).
#
# Runs ON the prod host. Pulls master, then rebuilds/reconfigures inside the
# cyberia_church container: the repo is bind-mounted into it, and node/php exist
# only inside the container, never on the host.
#
# Usage: bash /root/singularity/scripts/deploy-prod.sh
#
# CI invokes exactly that path over SSH (see the deploy job in
# .github/workflows/ci.yml). Because the script pulls itself, edits to this file
# take effect on the deploy AFTER the one that pulls them.
set -euo pipefail

REPO_DIR=${REPO_DIR:-/root/singularity}
CONTAINER=${CONTAINER:-cyberia_church}
APP_DIR=${APP_DIR:-/var/www/html}
COMPOSE_FILE=${COMPOSE_FILE:-$REPO_DIR/services/blockscout/docker-compose/docker-compose.yml}

in_container() {
    docker exec -w "$APP_DIR" "$CONTAINER" "$@"
}

in_docs_container() {
    docker exec -w /singularity/docs "$CONTAINER" "$@"
}

cd "$REPO_DIR"

before=$(git rev-parse HEAD)
git pull --ff-only
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ]; then
    echo "==> no new commits ($after) — running the full deploy anyway"
    # Manual re-deploys must still do something useful, so treat everything as changed.
    changed() { return 0; }
else
    echo "==> deploying $before -> $after"
    git --no-pager log --oneline "$before..$after"
    changed() { git diff --name-only "$before" "$after" -- "$@" | grep -q .; }
fi

# php.ini is baked into the application image rather than the bind-mounted
# source tree. Rebuild and recreate the app when its image definition changes;
# pulling those files alone leaves the running PHP limits untouched.
if changed backend/laravel/Dockerfile backend/laravel/docker/php.ini; then
    echo "==> rebuild Laravel runtime"
    docker compose -f "$COMPOSE_FILE" build cyberia_church
    docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate cyberia_church
fi

if changed backend/laravel/composer.lock; then
    echo "==> composer install"
    in_container composer install --no-interaction --no-dev --optimize-autoloader
fi

if changed backend/laravel/package-lock.json; then
    echo "==> npm ci"
    in_container npm ci
fi

if changed backend/laravel/resources backend/laravel/package.json backend/laravel/vite.config.ts backend/laravel/routes; then
    echo "==> npm run build"
    # A stale route cache makes wayfinder generate @/routes from the OLD route
    # table, so new pages fail the vite build with UNLOADABLE_DEPENDENCY.
    in_container php artisan route:clear
    in_container npm run build
fi

if changed docs; then
    echo "==> build docs.cyberia.church"
    # The Laravel container already carries the production Node toolchain and
    # bind-mounts the whole repository at /singularity. The host intentionally
    # has no Node installation of its own.
    in_docs_container npm ci
    in_docs_container npm run build
    test -s "$REPO_DIR/docs/.vitepress/dist/index.html" || {
        echo "docs build produced no index.html, refusing to deploy" >&2
        exit 1
    }
fi

if changed backend/laravel/database/migrations; then
    echo "==> migrate"
    in_container php artisan migrate --force
fi

# Web analytics (services/umami). Before the config cache, because it writes
# the console's sign-in password into .env; before the proxy, because it issues
# stats.cyberia.church's certificate. Never allowed to fail the site's deploy.
if changed services/umami; then
    echo "==> umami"
    bash "$REPO_DIR/services/umami/bootstrap.sh" \
        || echo "umami bootstrap failed; the site deploys regardless" >&2
fi

# Config is cached on prod: a stale bootstrap/cache/config.php makes Laravel
# ignore config/*.php AND .env entirely. Always refresh it. Routes are cached
# too, so rebuild that cache as well or new routes 404.
echo "==> config cache"
in_container php artisan config:clear
# Keep the env override aligned with the release shipped by this checkout.
# Read only release metadata into output; the rest of .env stays private.
in_container php -r '
require "vendor/autoload.php";
$app = require "bootstrap/app.php";
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$version = config("changelog.releases.0.version");
if (! is_string($version) || ! preg_match("/^v[0-9]+\\.[0-9]+\\.[0-9]+$/", $version)) {
    throw new RuntimeException("Invalid application release version");
}
$path = $app->environmentFilePath();
$contents = file_get_contents($path);
if ($contents === false) {
    throw new RuntimeException("Could not read application environment");
}
$updated = preg_match("/^APP_VERSION=/m", $contents)
    ? preg_replace("/^APP_VERSION=.*$/m", "APP_VERSION=".$version, $contents)
    : rtrim($contents).PHP_EOL."APP_VERSION=".$version.PHP_EOL;
if (file_put_contents($path, $updated, LOCK_EX) === false) {
    throw new RuntimeException("Could not update application version");
}
echo "==> application version ".$version.PHP_EOL;
'
in_container php artisan config:cache
in_container php artisan route:cache

echo "==> queue restart"
in_container php artisan queue:restart

# Static sites carry their own webroot certificates (the wildcard is renewed
# by hand). Cheap when they exist; never fails the deploy.
echo "==> site certificates"
bash "$REPO_DIR/scripts/ops/site-certs.sh" docs.cyberia.church blog.cyberia.church

# nginx templates are expanded only when the container starts. Recreate just
# the proxy when its template or mounts changed; application-only deploys do
# not disturb it. The documentation output itself is a bind mount and needs no
# reload after subsequent content-only builds.
if changed services/blockscout/docker-compose/proxy services/blockscout/docker-compose/services/nginx.yml; then
    echo "==> recreate proxy"
    docker compose \
        -f "$COMPOSE_FILE" \
        up -d --no-deps --force-recreate proxy
    docker exec proxy nginx -t
fi

# The explorer's indexer reads its settings only when its container is created,
# so a merged change to them used to sit in the checkout while the old process
# ran on: #133 (stop retrying traces polygon-edge cannot give, most of the
# host's load) was pulled and never applied. Converge on every deploy instead
# of diffing — compose recreates `backend` only when its resolved config no
# longer matches the running container, so an unchanged deploy is a no-op.
# --pull never: backend.yml says `pull_policy: always`, and the pinned tag is
# no longer on ghcr.io (`11.0.0: not found`), so asking the registry fails the
# whole step; the image the container runs is already on the host. A failure
# here must not fail the site's deploy, which has already finished above.
echo "==> converge explorer backend"
docker compose -f "$COMPOSE_FILE" up -d --no-deps --pull never backend \
    || echo "!! explorer backend did not converge — check: docker compose -f $COMPOSE_FILE up -d --no-deps backend"

if changed docs services/blockscout/docker-compose/proxy services/blockscout/docker-compose/services/nginx.yml; then
    echo "==> verify docs.cyberia.church"
    curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 2 \
        --max-time 20 https://docs.cyberia.church/ >/dev/null
fi

echo "==> deployed $(git rev-parse --short HEAD)"
