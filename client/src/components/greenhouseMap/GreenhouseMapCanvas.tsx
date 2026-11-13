import { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { CanvasTransform, clampPan, computeFitTransform, zoomAtPoint } from "../../lib/greenhouseMap/canvasTransform";
import { GreenhouseMap, MapRow, rowExtent } from "../../lib/greenhouseMap/types";

// The greenhouse map, adapted from LabourLink's GreenhouseLiveCanvas (row
// selection mode) and LandCanvas (phase dragging): world-feet SVG, one
// pan/zoom transform, drag empty space to pan, wheel to zoom at the cursor.
// Clicking a row selects it, Shift-click a range, clicking a phase's name
// selects the phase. What a row looks like (colour, tooltip) is up to the
// caller, so the Crop Planner and the map builder share one canvas.

export type RowAppearance = { fill?: string; className?: string; title: string };

type Props = {
  map: Pick<GreenhouseMap, "east_west_feet" | "north_south_feet" | "phases">;
  groupName: (groupId: string) => string;
  rowAppearance: (groupId: string, row: MapRow) => RowAppearance;
  selectedKeys?: Set<string>;
  onRowClick?: (groupId: string, rowNumber: number, opts: { shiftKey: boolean }) => void;
  onPhaseClick?: (groupId: string) => void;
  selectedPhaseId?: string | null;
  // Builder only: phases can be dragged; positions are reported in feet, snapped to snapFeet.
  onPhaseMove?: (groupId: string, xFeetFromWest: number, yFeetFromNorth: number) => void;
  snapFeet?: number;
  // Builder only: unsaved rows for one phase, drawn on top (red while invalid).
  preview?: { groupId: string; rows: MapRow[]; valid: boolean } | null;
  ariaLabel: string;
  toolbar?: ReactNode;
};

const ROW_LABEL_MIN_SCALE = 3;
const PAN_DRAG_THRESHOLD_PX = 4;
export const mapRowKey = (groupId: string, rowNumber: number) => `${groupId}:${rowNumber}`;

export function GreenhouseMapCanvas({
  map,
  groupName,
  rowAppearance,
  selectedKeys,
  onRowClick,
  onPhaseClick,
  selectedPhaseId,
  onPhaseMove,
  snapFeet = 0,
  preview,
  ariaLabel,
  toolbar
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState<CanvasTransform>({ pan: { x: 0, y: 0 }, scale: 1 });
  const [fitScale, setFitScale] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const fittedFor = useRef<string | null>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startY: number; startPan: { x: number; y: number }; captured: boolean } | null>(null);
  const dragRef = useRef<{ groupId: string; dx: number; dy: number } | null>(null);

  const fit = useCallback(() => {
    if (size.width <= 0 || size.height <= 0) return;
    const next = computeFitTransform(map, size.width, size.height);
    setFitScale(next.scale);
    setTransform(next);
  }, [map, size.width, size.height]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const report = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit once per land size (not on every edit, so the view doesn't jump while building).
  useEffect(() => {
    const key = `${map.east_west_feet}x${map.north_south_feet}:${size.width > 0 && size.height > 0}`;
    if (fittedFor.current === key || size.width <= 0) return;
    fittedFor.current = key;
    fit();
  }, [map.east_west_feet, map.north_south_feet, size.width, size.height, fit]);

  const minScale = fitScale * 0.25;
  const maxScale = fitScale * 12;

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setTransform((t) => zoomAtPoint(t, Math.min(maxScale, Math.max(minScale, t.scale * factor)), e.clientX - rect.left, e.clientY - rect.top));
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [minScale, maxScale]);

  function zoomBy(factor: number) {
    setTransform((t) => zoomAtPoint(t, Math.min(maxScale, Math.max(minScale, t.scale * factor)), size.width / 2, size.height / 2));
  }

  function toFeet(clientX: number, clientY: number) {
    const ctm = gRef.current?.getScreenCTM?.();
    if (!ctm) return null;
    const svg = gRef.current!.ownerSVGElement!;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  // ── Pan (empty canvas) ─────────────────────────────────────────────────────
  function onViewportPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 && e.button !== 1) return;
    panRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startPan: transform.pan, captured: false };
    if (e.button === 1) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panRef.current.captured = true;
      setIsPanning(true);
      e.preventDefault();
    }
  }
  function onViewportPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag && onPhaseMove) {
      const pt = toFeet(e.clientX, e.clientY);
      const phase = map.phases.find((p) => p.group_id === drag.groupId);
      if (!pt || !phase) return;
      let x = pt.x - drag.dx;
      let y = pt.y - drag.dy;
      if (snapFeet > 0) {
        x = Math.round(x / snapFeet) * snapFeet;
        y = Math.round(y / snapFeet) * snapFeet;
      }
      x = Math.max(0, Math.min(x, map.east_west_feet - phase.east_west_feet));
      y = Math.max(0, Math.min(y, map.north_south_feet - phase.north_south_feet));
      onPhaseMove(drag.groupId, Math.round(x * 100) / 100, Math.round(y * 100) / 100);
      return;
    }
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    if (!pan.captured) {
      if (Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) < PAN_DRAG_THRESHOLD_PX) return;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      pan.captured = true;
      setIsPanning(true);
    }
    const next = { x: pan.startPan.x + e.clientX - pan.startX, y: pan.startPan.y + e.clientY - pan.startY };
    setTransform((t) => ({ scale: t.scale, pan: clampPan(next, t.scale, map, size.width, size.height) }));
  }
  function onViewportPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
    dragRef.current = null;
    setIsPanning(false);
  }

  // ── Phase drag (builder) ───────────────────────────────────────────────────
  function onPhasePointerDown(e: ReactPointerEvent<SVGRectElement>, groupId: string) {
    if (!onPhaseMove || e.button !== 0) return;
    const phase = map.phases.find((p) => p.group_id === groupId);
    const pt = toFeet(e.clientX, e.clientY);
    if (!phase || !pt) return;
    e.stopPropagation();
    onPhaseClick?.(groupId);
    viewportRef.current?.setPointerCapture?.(e.pointerId);
    dragRef.current = { groupId, dx: pt.x - phase.x_feet_from_west, dy: pt.y - phase.y_feet_from_north };
  }

  function rowClick(e: ReactMouseEvent, groupId: string, rowNumber: number) {
    if (!onRowClick) return;
    e.stopPropagation();
    onRowClick(groupId, rowNumber, { shiftKey: e.shiftKey });
  }

  const showLabels = transform.scale >= ROW_LABEL_MIN_SCALE;
  const renderRow = (groupId: string, px: number, py: number, row: MapRow, look: RowAppearance, key: string, selected: boolean, interactive: boolean) => {
    const { width, height } = rowExtent(row);
    const x = px + row.x_ft;
    const y = py + row.y_ft;
    return (
      <g key={key}>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          className={`gh-map-row${look.className ? ` ${look.className}` : ""}${selected ? " selected" : ""}${interactive && onRowClick ? " clickable" : ""}`}
          style={look.fill && !selected ? { fill: look.fill } : undefined}
          vectorEffect="non-scaling-stroke"
          role={interactive ? (onRowClick ? "button" : "img") : undefined}
          aria-pressed={interactive && onRowClick ? selected : undefined}
          aria-label={interactive ? look.title.split("\n").join(", ") : undefined}
          data-row-key={interactive ? mapRowKey(groupId, row.row_number) : undefined}
          onClick={interactive ? (e) => rowClick(e, groupId, row.row_number) : undefined}
          pointerEvents={interactive ? undefined : "none"}
        >
          <title>{look.title}</title>
        </rect>
        {showLabels ? (
          <text
            x={x + width / 2}
            y={y + height / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={Math.min(Math.min(width, height) * 0.6, 12 / transform.scale)}
            className="gh-map-row-label"
            pointerEvents="none"
          >
            {row.row_number}
          </text>
        ) : null}
      </g>
    );
  };

  return (
    <div className="gh-map">
      <div className="gh-map-controls">
        {toolbar}
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">−</button>
        <button type="button" onClick={fit}>Fit to screen</button>
      </div>
      <div
        ref={viewportRef}
        className={`gh-map-viewport${isPanning ? " panning" : ""}`}
        onPointerDown={onViewportPointerDown}
        onPointerMove={onViewportPointerMove}
        onPointerUp={onViewportPointerUp}
        onPointerCancel={onViewportPointerUp}
      >
        <svg className="gh-map-svg" role="group" aria-label={ariaLabel}>
          <g ref={gRef} transform={`translate(${transform.pan.x} ${transform.pan.y}) scale(${transform.scale})`}>
            <rect x={0} y={0} width={map.east_west_feet} height={map.north_south_feet} className="gh-map-land" vectorEffect="non-scaling-stroke" />
            {map.phases.map((phase) => {
              const px = phase.x_feet_from_west;
              const py = phase.y_feet_from_north;
              const name = groupName(phase.group_id);
              const labelSize = Math.max(10 / transform.scale, Math.min(phase.east_west_feet, phase.north_south_feet) * 0.04);
              const isPreview = preview?.groupId === phase.group_id;
              return (
                <g key={phase.group_id}>
                  <rect
                    x={px}
                    y={py}
                    width={phase.east_west_feet}
                    height={phase.north_south_feet}
                    className={`gh-map-phase${selectedPhaseId === phase.group_id ? " selected" : ""}${onPhaseMove ? " draggable" : ""}`}
                    vectorEffect="non-scaling-stroke"
                    onPointerDown={(e) => onPhasePointerDown(e, phase.group_id)}
                    onClick={onPhaseMove ? undefined : (e) => e.stopPropagation()}
                  >
                    <title>{`${name} — ${phase.east_west_feet} ft × ${phase.north_south_feet} ft`}</title>
                  </rect>
                  {phase.rows.map((row) => {
                    const key = mapRowKey(phase.group_id, row.row_number);
                    return renderRow(phase.group_id, px, py, row, rowAppearance(phase.group_id, row), key, Boolean(selectedKeys?.has(key)), true);
                  })}
                  {isPreview
                    ? preview!.rows.map((row) =>
                        renderRow(phase.group_id, px, py, row, { className: preview!.valid ? "preview" : "preview-invalid", title: `Row ${row.row_number} (not saved)` }, `preview-${row.row_number}`, false, false)
                      )
                    : null}
                  <text
                    x={px + labelSize * 0.4}
                    y={py - labelSize * 0.35}
                    fontSize={labelSize}
                    className={`gh-map-phase-label${onPhaseClick ? " clickable" : ""}`}
                    role={onPhaseClick ? "button" : undefined}
                    aria-label={onPhaseClick ? `Select ${name}` : undefined}
                    onClick={
                      onPhaseClick
                        ? (e) => {
                            e.stopPropagation();
                            onPhaseClick(phase.group_id);
                          }
                        : undefined
                    }
                  >
                    {name}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="gh-map-compass" aria-hidden="true">▲<span>N</span></div>
      </div>
    </div>
  );
}
