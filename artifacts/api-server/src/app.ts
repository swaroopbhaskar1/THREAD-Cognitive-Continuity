import express, { type Express } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } from "./middlewares/clerkProxyMiddleware";
import { securityHeadersAndAdmission, protectLearningAPI, safeRequestErrors } from "./middlewares/security";
import { noteSignal } from "./lib/operational-signals";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.once("finish", () => { if (res.statusCode >= 500) noteSignal("server_error"); });
  next();
});
app.disable("x-powered-by");
app.use(securityHeadersAndAdmission);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(express.json({ limit: "1mb", inflate: false }));
app.use(express.urlencoded({ extended: false, limit: "16kb", inflate: false, parameterLimit: 30 }));
app.use(clerkMiddleware(req => ({
  publishableKey: publishableKeyFromHost(getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY),
})));

app.use("/api", protectLearningAPI, router);
app.use(safeRequestErrors);

export default app;
