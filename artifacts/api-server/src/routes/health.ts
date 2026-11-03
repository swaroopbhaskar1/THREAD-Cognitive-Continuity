import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { databaseReady } from "../lib/readiness";

const router: IRouter = Router();

router.get("/readyz", async (_req, res) => {
  const ready = await databaseReady();
  res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "unavailable" });
});

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
