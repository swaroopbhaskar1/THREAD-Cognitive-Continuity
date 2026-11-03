import { Router } from "express";
import { getAuth } from "@clerk/express";
import { ReportClientSignalBody } from "@workspace/api-zod";
import { transaction } from "../lib/execution";
import { consumeLimit } from "../lib/limits";
import { noteSignal } from "../lib/operational-signals";

const router = Router();
router.post("/operations/client-signal", async (req, res, next) => {
  try {
    const owner = getAuth(req).userId;
    if (!owner) { res.status(401).json({ code: "UNAUTHENTICATED" }); return; }
    if (!ReportClientSignalBody.safeParse(req.body).success) { res.status(400).json({ code: "VALIDATION_FAILED" }); return; }
    const admission = await transaction(c => consumeLimit(c, "client-sse-signal", owner, 1, 300));
    if (admission.allowed) noteSignal("client_sse_failure");
    res.status(202).json({ accepted: true });
  } catch (error) { next(error); }
});
export default router;
