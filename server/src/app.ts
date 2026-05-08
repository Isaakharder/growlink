import cors from "cors";
import express from "express";
import { greenhouseSetupRouter } from "./routes/greenhouseSetup";
import { healthRouter } from "./routes/health";
import { irrigationSetupRouter } from "./routes/irrigationSetup";
import { mobileDailyYieldRouter } from "./routes/mobileDailyYield";
import { mobileIrrigationLogRouter } from "./routes/mobileIrrigationLog";
import { varietiesRouter } from "./routes/varieties";
import { yieldEntriesRouter } from "./routes/yieldEntries";
import { yieldSizesRouter } from "./routes/yieldSizes";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api", healthRouter);
app.use("/api", greenhouseSetupRouter);
app.use("/api", irrigationSetupRouter);
app.use("/api", varietiesRouter);
app.use("/api", yieldEntriesRouter);
app.use("/api", yieldSizesRouter);
app.use("/api", mobileDailyYieldRouter);
app.use("/api", mobileIrrigationLogRouter);

export { app };
