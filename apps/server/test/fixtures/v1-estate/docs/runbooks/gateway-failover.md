# Gateway failover

The `gateway` host is the router / firewall at the edge of the network. If it
stops forwarding traffic, work through the checks below before failing over.

## Symptoms

- No outbound connectivity from any host.
- `router-ui` unreachable on `https://gateway.home.example/`.
- Deck shows `gateway` as **stale** or **unreachable** in the Hosts view.

## Checklist

1. Confirm power and the WAN link LED.
2. Reach the console on the management address (`192.0.2.1`).
3. Restart the routing service:

   ```sh
   ssh admin@gateway.home.example
   sudo systemctl restart routing
   ```

4. If the appliance is unresponsive, fail over to the cold-spare router and
   re-point the `lan` gateway address.

## After recovery

- Verify DNS resolution from `nas` and `apps`.
- Refresh the deck snapshot so the Hosts view returns to **fresh**.
