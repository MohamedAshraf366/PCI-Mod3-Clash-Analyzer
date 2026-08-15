/**
 * Runs the expensive geometry / graph work (clash analysis + PCI re-plan) off
 * the main thread so large site tables never freeze the UI or trigger the
 * browser's "Page unresponsive" dialog. See `use-clash-worker.ts` for the
 * hook that talks to this worker from React.
 */
import {
  analyzeClashes,
  getPerf,
  suggestPciPlan,
  type Cell,
  type Clash,
  type ClashGroup,
  type ClashOptions,
  type PciSuggestion,
  type PerfStats,
} from "./mod3";

export type AnalyzeRequest = {
  kind: "analyze";
  id: number;
  cells: Cell[];
  opts: ClashOptions;
};

export type ReplanRequest = {
  kind: "replan";
  id: number;
  cells: Cell[];
  clashes: Clash[];
  opts: ClashOptions;
};

export type WorkerRequest = AnalyzeRequest | ReplanRequest;

export type AnalyzeResponse = {
  kind: "analyze";
  id: number;
  clashes: Clash[];
  groups: ClashGroup[];
  perf: PerfStats;
};

export type ReplanSuggestion = {
  cell: Cell;
  oldPci: number;
  oldMod3: number;
  newPci: number;
  newMod3: number;
  clashCount: number;
  conflictsWith: string[];
  note: string;
};

export type ReplanResponse = {
  kind: "replan";
  id: number;
  suggestions: ReplanSuggestion[];
  resolvedCells: Cell[];
  resolvedClashes: Clash[];
  resolvedGroups: ClashGroup[];
};

export type WorkerResponse = AnalyzeResponse | ReplanResponse;

function handleAnalyze(req: AnalyzeRequest): AnalyzeResponse {
  const { clashes, groups } = analyzeClashes(req.cells, req.opts);
  return { kind: "analyze", id: req.id, clashes, groups, perf: getPerf() };
}

/** Same logic the UI used to run inline: prefer same-site rotations, then safe LTE PCI assignments. */
function handleReplan(req: ReplanRequest): ReplanResponse {
  let current = req.cells;
  const notes = new Map<string, { clashCount: number; conflictsWith: string[]; note: string }>();

  if (req.clashes.length) {
    const sug: PciSuggestion[] = suggestPciPlan(current, req.clashes, req.opts);
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

  const { clashes: resolvedClashes, groups: resolvedGroups } = analyzeClashes(current, req.opts);

  return {
    kind: "replan",
    id: req.id,
    suggestions,
    resolvedCells: current,
    resolvedClashes,
    resolvedGroups,
  };
}

// `self` inside a module worker is the DedicatedWorkerGlobalScope. Cast it so
// this file can be type-checked under the DOM lib without pulling in the
// (conflicting) WebWorker lib for the whole project.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
};

ctx.onmessage = (e) => {
  const req = e.data;
  ctx.postMessage(req.kind === "analyze" ? handleAnalyze(req) : handleReplan(req));
};

export {};
