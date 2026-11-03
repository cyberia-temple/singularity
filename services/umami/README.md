# Cyberia web analytics (Umami)

Traffic for cyberia.church, lain-os.com and chaos.fm, counted on this host:
visits, pages, sources and campaigns, countries, devices, events, funnels,
retention, user journeys and Web Vitals. [Umami](https://umami.is) 3.4.1, MIT,
one Node container and its own Postgres. Nothing it collects leaves the host,
and telemetry and update checks are off.

- **Dashboard:** https://stats.cyberia.church. Operators open it already signed
  in from the console (`/crm/stats`, rail item «Аналитика»).
- **Tracker:** `https://stats.cyberia.church/s.js`, posting to `/api/c`. Those
  names are chosen so blocker lists do not recognise them.
- **Tags:** `App\Support\WebStats` (cyberia.church) and lain-labs/backend's
  `partials/session-replay.blade.php` (lain-os.com, chaos.fm). The tags are
  skipped for exactly the people the session recorder skips. A before-send hook
  drops every query parameter except `utm_*` and `ref`, and honours the
  visitor's own opt-out.

## Deploy

`scripts/deploy-prod.sh` runs `bootstrap.sh` whenever this directory changes,
and it can also be run by hand. It is idempotent:

1. It writes `.env` with generated secrets (gitignored, never printed).
2. It starts the containers and replaces the seeded `admin`/`umami` password
   with the generated one.
3. It creates the three websites under the fixed ids the tags carry:

   | Site | Website id |
   |------|------------|
   | cyberia.church | `4955f251-c9ac-464b-adce-14c8ea75eaf2` |
   | lain-os.com | `deae2ba0-e146-4884-8615-c4e22a97f811` |
   | chaos.fm | `c5eeb8dc-7bf2-4b3d-b1e3-1aca8d9686f6` |

4. It issues `stats.cyberia.church` its own webroot certificate. The
   `certbot renew` cron renews it, unlike the hand-renewed wildcard.
5. It writes `UMAMI_ADMIN_PASSWORD` into Laravel's `.env` for the console's
   sign-in.

If you need the dashboard password itself, it is `UMAMI_ADMIN_PASSWORD` in
`/root/singularity/services/umami/.env`.

## Check

```bash
cd services/umami && docker compose --env-file .env config >/dev/null
docker exec umami curl -fsS http://localhost:3000/api/heartbeat
```
