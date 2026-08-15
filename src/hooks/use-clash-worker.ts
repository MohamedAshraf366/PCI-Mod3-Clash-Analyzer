"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Cell, Clash, ClashGroup, ClashOptions } from "@/lib/mod3";
import type {
  AnalyzeResponse,
  ReplanResponse,
  ReplanSuggestion,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/clash-worker";

export type AnalyzeResult = {
  clashes: Clash[];
  groups: ClashGroup[];
  perf: AnalyzeResponse["perf"];
};
export type ReplanResult = {
  suggestions: ReplanSuggestion[];
  resolvedCells: Cell[];
  resolvedClashes: Clash[];
  resolvedGroups: ClashGroup[];
};

/**
 * Runs clash analysis and PCI re-planning on a background thread. Falls back
 * to running synchronously on the main thread if Web Workers are unavailable
 * (e.g. very old browsers), so the feature never breaks — it just stops being
 * off-thread.
 */
export function useClashWorker() {
  const workerRef = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, (res: WorkerResponse) => void>());
  const nextId = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined" || typeof Worker === "undefined") return;
    const worker = new Worker(new URL("../lib/clash-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const resolve = pending.current.get(e.data.id);
      if (resolve) {
        pending.current.delete(e.data.id);
        resolve(e.data);
      }
    };
    workerRef.current = worker;
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((req: WorkerRequest): Promise<WorkerResponse> => {
    const worker = workerRef.current;
    if (!worker) {
      // No Web Worker support (or not mounted yet): fall back to the exact
      // same computation, just synchronously on the main thread, so the
      // feature still works everywhere.
      return import("@/lib/mod3").then(({ analyzeClashes, suggestPciPlan, getPerf }) => {
        if (req.kind === "analyze") {
          const { clashes, groups } = analyzeClashes(req.cells, req.opts);
          const response: AnalyzeResponse = {
            kind: "analyze",
            id: req.id,
            clashes,
            groups,
            perf: getPerf(),
          };
          return response;
        }
        let current = req.cells;
        const notes = new Map<
          string,
          { clashCount: number; conflictsWith: string[]; note: string }
        >();
        if (req.clashes.length) {
          const sug = suggestPciPlan(current, req.clashes, req.opts);
          const byId = new Map(sug.filter((s) => s.newPci != null).map((s) => [s.cell.id, s]));
          current = current.map((c) => {
            const s = byId.get(c.id);
            return s && s.newPci != null ? { ...c, pci: s.newPci, mod3: s.newPci % 3 } : c;
          });
          sug.forEach((s) => {
            if (s.newPci != null)
              notes.set(s.cell.id, {
                clashCount: s.clashCount,
                conflictsWith: s.conflictsWith,
                note: s.note,
              });
          });
        }
        const orig = new Map(req.cells.map((c) => [c.id, c]));
        const suggestions: ReplanSuggestion[] = current
          .filter((c) => (orig.get(c.id)?.pci ?? c.pci) !== c.pci)
          .map((c) => {
            const o = orig.get(c.id)!;
            const n = notes.get(c.id);
            return {
              cell: o,
              oldPci: o.pci,
              oldMod3: o.mod3,
              newPci: c.pci,
              newMod3: c.mod3,
              clashCount: n?.clashCount ?? 0,
              conflictsWith: n?.conflictsWith ?? [],
              note:
                n?.note ??
                `Rotate PCI inside site ${o.site}: ${o.pci} (Mod3 ${o.mod3}) → ${c.pci} (Mod3 ${c.mod3}).`,
            };
          })
          .sort((a, b) => b.clashCount - a.clashCount);
        const { clashes: resolvedClashes, groups: resolvedGroups } = analyzeClashes(
          current,
          req.opts,
        );
        const response: ReplanResponse = {
          kind: "replan",
          id: req.id,
          suggestions,
          resolvedCells: current,
          resolvedClashes,
          resolvedGroups,
        };
        return response;
      });
    }
    return new Promise((resolve) => {
      pending.current.set(req.id, resolve);
      worker.postMessage(req);
    });
  }, []);

  const runAnalyze = useCallback(
    (cells: Cell[], opts: ClashOptions): Promise<AnalyzeResult> => {
      const id = ++nextId.current;
      return send({ kind: "analyze", id, cells, opts }).then((res) => {
        const r = res as AnalyzeResponse;
        return { clashes: r.clashes, groups: r.groups, perf: r.perf };
      });
    },
    [send],
  );

  const runReplan = useCallback(
    (cells: Cell[], clashes: Clash[], opts: ClashOptions): Promise<ReplanResult> => {
      const id = ++nextId.current;
      return send({ kind: "replan", id, cells, clashes, opts }).then((res) => {
        const r = res as ReplanResponse;
        return {
          suggestions: r.suggestions,
          resolvedCells: r.resolvedCells,
          resolvedClashes: r.resolvedClashes,
          resolvedGroups: r.resolvedGroups,
        };
      });
    },
    [send],
  );

  return { runAnalyze, runReplan };
}
