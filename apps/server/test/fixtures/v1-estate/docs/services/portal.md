# Portal service

`portal` is the home dashboard, a `docker-compose` stack on the `apps` host. It
sits behind the `reverse-proxy` service for TLS.

## Stack

- **portal** — the dashboard UI.
- **reverse-proxy** — terminates TLS and routes `portal.home.example`.

## Operations

```sh
ssh admin@apps.home.example
cd /opt/portal
docker compose pull && docker compose up -d
```

## Health

Deck reads the container state through the snapshot. When the `apps` host is
only **partially** collected (for example, the config collector fails), the
container list still renders but managed-config drift may be unknown.
