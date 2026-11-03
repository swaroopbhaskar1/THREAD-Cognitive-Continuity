import { Router, type IRouter } from "express";
import healthRouter from "./health";
import threadRouter from "./thread";
import reviewRouter from "./reviews";
import operationsRouter from "./operations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(threadRouter);
router.use(reviewRouter);
router.use(operationsRouter);

export default router;
