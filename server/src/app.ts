import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { requireOrganizationContext } from "./middleware/requireOrganizationContext";
import { adminCustomersRouter } from "./routes/adminCustomers";
import { adminOrganizationsRouter } from "./routes/adminOrganizations";
import { adminFlowMasterImportRunsRouter } from "./routes/adminFlowMasterImportRuns";
import { adminUploadKeysRouter } from "./routes/adminUploadKeys";
import { agentPendingImportsRouter } from "./routes/agentPendingImports";
import { invitesPublicRouter, invitesRouter } from "./routes/invites";
import { usersRouter } from "./routes/users";
import { agentRouter } from "./routes/agentRoutes";
import { greenhouseSetupRouter } from "./routes/greenhouseSetup";
import { pestControlRouter } from "./routes/pestControl";
import { h1Router } from "./routes/foodSafetyH1";
import { qualityRouter } from "./routes/quality";
import { healthRouter } from "./routes/health";
import { integrationsRouter } from "./routes/integrations";
import { irrigationSetupRouter } from "./routes/irrigationSetup";
import { mobileDailyYieldRouter } from "./routes/mobileDailyYield";
import { mobileIrrigationLogRouter } from "./routes/mobileIrrigationLog";
import { pdfImportRouter } from "./routes/pdfImport";
import { varietiesRouter } from "./routes/varieties";
import { yieldEntriesRouter } from "./routes/yieldEntries";
import { yieldProjectionsRouter } from "./routes/yieldProjections";
import { yieldSizesRouter } from "./routes/yieldSizes";

const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

function buildAllowedOrigins(): Set<string> {
  const origins = new Set(DEV_ORIGINS);
  const env = process.env.CORS_ORIGINS ?? "";
  for (const raw of env.split(",")) {
    const origin = raw.trim();
    if (origin) origins.add(origin);
  }
  return origins;
}

const allowedOrigins = buildAllowedOrigins();

// General API limiter — applied to every /api route.
// Generous enough not to affect normal use, tight enough to blunt abuse.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many requests. Please try again later." }
});

// Strict limiter for expensive write-heavy endpoints:
// DockLink sync (full-table fetch) and PDF batch upload (CPU + DB intensive).
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many requests for this operation. Please wait before retrying." }
});

const app = express();

app.use(
  cors({
    origin(requestOrigin, callback) {
      // No Origin header means the request is from a non-browser client
      // (curl, health check, server-to-server). Allow it — there is no
      // ambient credential risk without a browser context.
      if (!requestOrigin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.has(requestOrigin)) {
        callback(null, true);
      } else {
        // Return false rather than an Error so Express error handling is not
        // triggered. The browser will see no CORS headers and block the request.
        callback(null, false);
      }
    },
    allowedHeaders: ["Authorization", "Content-Type", "X-Upload-Key"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
  })
);

app.use(express.json({ limit: "1mb" }));

// Rate limiting — applied before any route logic runs.
app.use("/api", apiLimiter);
app.use("/api/agent/pdf-import", strictLimiter);
app.use("/api/integrations/docklink/sync-color-cases", strictLimiter);
app.use("/api/pdf-import", strictLimiter);

app.use("/api", healthRouter);
app.use("/api", adminCustomersRouter);
app.use("/api", adminOrganizationsRouter);
app.use("/api", adminFlowMasterImportRunsRouter);
app.use("/api", adminUploadKeysRouter);
app.use("/api", agentRouter);
app.use("/api", invitesPublicRouter);
app.use("/api", requireOrganizationContext);
app.use("/api", agentPendingImportsRouter);
app.use("/api", invitesRouter);
app.use("/api", usersRouter);
app.use("/api", pdfImportRouter);
app.use("/api", greenhouseSetupRouter);
app.use("/api", pestControlRouter);
app.use("/api", h1Router);
app.use("/api", qualityRouter);
app.use("/api", integrationsRouter);
app.use("/api", irrigationSetupRouter);
app.use("/api", varietiesRouter);
app.use("/api", yieldEntriesRouter);
app.use("/api", yieldProjectionsRouter);
app.use("/api", yieldSizesRouter);
app.use("/api", mobileDailyYieldRouter);
app.use("/api", mobileIrrigationLogRouter);

export { app };
