# NAS recovery

The `nas` host is the storage and backup target. It runs `files` (SMB shares)
and the nightly `backups` job, and hosts the `apps` and `media` VMs.

## Restore a share

1. Stop the `files` service so nothing writes mid-restore:

   ```sh
   sudo systemctl stop files
   ```

2. Restore from the most recent good snapshot in `nas-local`.
3. Verify permissions, then start the service again.

## Backups

The nightly `backups` job is expected to complete before 05:00. If deck shows
it **degraded**, check the job log:

```sh
journalctl -u backups --since "yesterday"
```

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Job never ran | Timer disabled | `systemctl enable --now backups.timer` |
| Job ran, target full | Retention too long | Prune old snapshots |
| Partial transfer | Network blip | Re-run manually |

> A drifted managed config on `nas` (see the Drift view) is the usual reason the
> backup target path disagrees with expectations.
