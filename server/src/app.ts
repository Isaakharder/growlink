import cors from "cors";
import express from "express";
import { requireOrganizationContext } from "./middleware/requireOrganizationContext";
import { adminOrganizationsRouter } from "./routes/adminOrganizations";
import { adminUploadKeysRouter } from "./routes/adminUploadKeys";
import { agentRouter } from "./routes/agentRoutes";
import { greenhouseSetupRouter } from "./routes/greenhouseSetup";
import { healthRouter } from "./routes/health";
import { integrationsRouter } from "./routes/integrations";
import { irrigationSetupRouter } from "./routes/irrigationSetup";
import { mobileDailyYieldRouter } from "./routes/mobileDailyYield";
import { mobileIrrigationLogRouter } from "./routes/mobileIrrigationLog";
import { pdfImportRouter } from "./routes/pdfImport";
import { varietiesRouter } from "./routes/varieties";
import { yieldEntriesRouter } from "./routes/yieldEntries";
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

app.use(express.json());

app.use("/api", healthRouter);
app.use("/api", adminOrganizationsRouter);
app.use("/api", adminUploadKeysRouter);
app.use("/api", agentRouter);
app.use("/api", requireOrganizationContext);
app.use("/api", pdfImportRouter);
app.use("/api", greenhouseSetupRouter);
app.use("/api", integrationsRouter);
app.use("/api", irrigationSetupRouter);
app.use("/api", varietiesRouter);
app.use("/api", yieldEntriesRouter);
app.use("/api", yieldSizesRouter);
app.use("/api", mobileDailyYieldRouter);
app.use("/api", mobileIrrigationLogRouter);

export { app };
