import fs from "fs";
import path from "path";
import { parseWeatherStationCsv } from "../parsers/weatherStation";
import { parseBlockSummaryCsv } from "../parsers/blockSummary";
import { ClimateFileType, ParsedReading } from "../parsers/types";
import { parseExportTimestampFromFilename, sha256 } from "../util";

const API_BASE_URL = process.env.GROWLINK_API_URL || "http://localhost:4000/api";
const UPLOAD_KEY = process.env.GROWLINK_UPLOAD_KEY;
const SAMPLES_DIR = path.join(__dirname, "..", "..", "samples");

interface SampleFile {
  filename: string;
  fileType: ClimateFileType;
}

// GrowLink only accepts Weather Station (Radiation Sum) imports. Block
// summary exports belong to CropLink and are not sent here.
const SAMPLE_FILES: SampleFile[] = [
  { filename: "Weather stations_20260613_210007.csv", fileType: "weather_station" },
];

function parseFile(fileType: ClimateFileType, content: string): ParsedReading[] {
  return fileType === "weather_station"
    ? parseWeatherStationCsv(content)
    : parseBlockSummaryCsv(content);
}

async function importFile(sample: SampleFile) {
  const filePath = path.join(SAMPLES_DIR, sample.filename);
  const content = fs.readFileSync(filePath, "utf8");

  const exportTimestamp = parseExportTimestampFromFilename(sample.filename);
  if (!exportTimestamp) {
    throw new Error(`could not parse export timestamp from filename: ${sample.filename}`);
  }

  const readings = parseFile(sample.fileType, content);
  const fileHash = sha256(content);

  console.log(`\n--- ${sample.filename} ---`);
  console.log(`file_type: ${sample.fileType}`);
  console.log(`export_timestamp: ${exportTimestamp.toISOString()}`);
  console.log(`file_hash: ${fileHash}`);
  console.log(`parsed readings: ${readings.length}`);

  const response = await fetch(`${API_BASE_URL}/agent/climate-import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Key": UPLOAD_KEY ?? "",
    },
    body: JSON.stringify({
      source_file: sample.filename,
      file_type: sample.fileType,
      export_timestamp: exportTimestamp.toISOString(),
      file_hash: fileHash,
      readings,
    }),
  });

  const body = await response.json();
  console.log(`response status: ${response.status}`);
  console.log(`response body:`, body);
}

async function main() {
  if (!UPLOAD_KEY) {
    throw new Error("GROWLINK_UPLOAD_KEY environment variable is required.");
  }
  for (const sample of SAMPLE_FILES) {
    await importFile(sample);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
