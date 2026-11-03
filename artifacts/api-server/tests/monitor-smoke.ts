// Explicit manual, DEVELOPMENT-ONLY email check. Not imported by automated tests.
import { pool } from "@workspace/db";
import { reconcileAlerts, deliverOne } from "../src/lib/operational-monitor";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("DEVELOPMENT_ONLY");
  const marker = await pool.query("SELECT scope FROM environment_markers");
  if (marker.rows.some(r => r.scope === "production")) throw new Error("DEVELOPMENT_ONLY");
  const scope = "controlled-notification-check";
  await reconcileAlerts(scope, [{ code: "CONTROLLED_NOTIFICATION_TEST", severity: "test", observed: 1, threshold: 1 }]);
  await deliverOne(scope);
  const receipt = await pool.query(`SELECT d.id,d.state,d.attempts,d.provider_id,d.last_error,d.duration_ms,d.accepted_at
    FROM operational_deliveries d JOIN operational_alerts a ON a.id=d.alert_id
    WHERE a.scope=$1 ORDER BY d.created_at DESC LIMIT 1`, [scope]);
  console.log(JSON.stringify({ controlledTest: true, receipt: receipt.rows[0], inboxDeliveryVerified: false }));
}
main().catch(() => { console.error("CONTROLLED_NOTIFICATION_CHECK_FAILED"); process.exitCode = 1; }).finally(() => pool.end());
