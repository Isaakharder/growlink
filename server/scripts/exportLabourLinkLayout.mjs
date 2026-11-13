#!/usr/bin/env node
// Exports a LabourLink greenhouse map as a layout file the GrowLink map
// builder can import (Crop Planner → Greenhouse map → Import from LabourLink).
//
// READ ONLY. It issues GET requests to LabourLink's REST API and nothing else.
// The file holds layout geometry only: each land's size, each active phase's
// name, position and size, and each active row's number, position, size and
// orientation. Employees, employee blocks, plant densities, work status,
// time entries, NFC tags, displays and credentials are never read or written.
//
// Usage (credentials come from the environment, never from the file):
//   LABOURLINK_SUPABASE_URL=... LABOURLINK_SUPABASE_SERVICE_ROLE_KEY=... \
//     node server/scripts/exportLabourLinkLayout.mjs [--land "<land name>"] > layout.json
import process from "node:process";

const url = process.env.LABOURLINK_SUPABASE_URL;
const key = process.env.LABOURLINK_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set LABOURLINK_SUPABASE_URL and LABOURLINK_SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}
const landArg = process.argv.indexOf("--land");
const landName = landArg > -1 ? process.argv[landArg + 1] : null;

async function get(path) {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      method: "GET",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` }
    });
    if (!response.ok) throw new Error(`GET ${path.split("?")[0]} failed: ${response.status}`);
    const page = await response.json();
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

const num = (v) => Number(v);
const lands = await get("greenhouse_lands?select=id,name,east_west_feet,north_south_feet,is_active&order=name.asc");
const phases = await get(
  "greenhouse_phases?select=id,land_id,name,east_west_feet,north_south_feet,x_feet_from_west,y_feet_from_north,is_active,sort_order&is_active=eq.true&order=sort_order.asc.nullslast,name.asc"
);
const rows = await get(
  "greenhouse_rows?select=phase_id,row_number,x_ft,y_ft,width_ft,length_ft,orientation&deleted_at=is.null&order=phase_id.asc,row_number.asc"
);

const chosen = lands.filter((l) => l.is_active && (!landName || l.name === landName));
if (chosen.length === 0) {
  console.error(landName ? `No active land named ${landName}.` : "No active lands.");
  process.exit(1);
}

const layout = {
  format: "labourlink-greenhouse-layout",
  version: 1,
  exportedAt: new Date().toISOString(),
  lands: chosen.map((land) => ({
    name: land.name,
    eastWestFeet: num(land.east_west_feet),
    northSouthFeet: num(land.north_south_feet),
    phases: phases
      .filter((p) => p.land_id === land.id)
      .map((phase) => ({
        name: phase.name,
        xFeetFromWest: num(phase.x_feet_from_west),
        yFeetFromNorth: num(phase.y_feet_from_north),
        eastWestFeet: num(phase.east_west_feet),
        northSouthFeet: num(phase.north_south_feet),
        sortOrder: phase.sort_order,
        rows: rows
          .filter((r) => r.phase_id === phase.id)
          .map((r) => ({
            rowNumber: r.row_number,
            xFt: num(r.x_ft),
            yFt: num(r.y_ft),
            widthFt: num(r.width_ft),
            lengthFt: num(r.length_ft),
            orientation: r.orientation
          }))
      }))
  }))
};

process.stdout.write(JSON.stringify(layout, null, 2) + "\n");
