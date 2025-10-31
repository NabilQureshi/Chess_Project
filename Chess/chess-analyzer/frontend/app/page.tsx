"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import ChessBoardView from "./components/ChessBoardView";

const API = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8080";

async function readBody(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text || `HTTP ${res.status}` }; }
}

type MoveRow = {
  ply: number;
  side: "white" | "black";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  bestmove: string;
  evalBestCp: number;
  evalHumanCp: number;
  deltaCp: number;
  verdict: "Great" | "Good" | "Inaccuracy" | "Mistake" | "Blunder";
  note?: string;
  better?: string;
};

type Report = { moves: MoveRow[]; summary: { inaccuracies: number; mistakes: number; blunders: number } };
type Scope = "both" | "white" | "black";

export default function AnalyzeGame() {
  const [pgn, setPgn] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // which position (0 = initial; k = after ply k)
  const [idx, setIdx] = useState(0);
  const [scope, setScope] = useState<Scope>("both"); // All / White / Black

  // FEN timeline: initial + each ply
  const fens = useMemo(() => {
    if (!report?.moves?.length) return [];
    const arr: string[] = [];
    const firstBefore = report.moves[0]?.fenBefore?.trim?.();
    if (firstBefore) arr.push(firstBefore);
    for (const m of report.moves) arr.push(m.fenAfter?.trim?.());
    return arr;
  }, [report]);

  const currentFen = (fens[idx] ?? "").trim();

  // Visible positions based on scope (array of position indices = ply+1)
  const visiblePositions = useMemo<number[]>(() => {
    if (!report?.moves?.length) return [];
    return report.moves
      .map((m, i) => ({ posIndex: i + 1, side: m.side }))
      .filter((x) => scope === "both" || x.side === scope)
      .map((x) => x.posIndex);
  }, [report, scope]);

  const atFirst = visiblePositions.length
    ? (visiblePositions.indexOf(idx) <= 0)
    : true;
  const atLast = visiblePositions.length
    ? (visiblePositions.indexOf(idx) >= visiblePositions.length - 1)
    : true;

  function jumpPrev() {
    if (!visiblePositions.length) return;
    const i = visiblePositions.indexOf(idx);
    if (i === -1) {
      const lower = visiblePositions.filter((p) => p < idx);
      setIdx(lower.length ? lower[lower.length - 1] : visiblePositions[0]);
    } else if (i > 0) {
      setIdx(visiblePositions[i - 1]);
    }
  }
  function jumpNext() {
    if (!visiblePositions.length) return;
    const i = visiblePositions.indexOf(idx);
    if (i === -1) {
      const higher = visiblePositions.find((p) => p > idx);
      setIdx(higher ?? visiblePositions[visiblePositions.length - 1]);
    } else if (i < visiblePositions.length - 1) {
      setIdx(visiblePositions[i + 1]);
    }
  }

  async function runAnalyze() {
    setError(null);
    setReport(null);
    setIdx(0);
    setLoading(true);
    try {
      const parse = await fetch(`${API}/parse`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn }),
      });
      if (!parse.ok) {
        const b = await readBody(parse);
        setError(b?.error ?? `PGN parse failed (${parse.status})`);
        return;
      }
      const res = await fetch(`${API}/analyzeGame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn, depth: 16, multipv: 3, withCoach: true, scope }),
      });
      const body = await readBody(res);

      if (!res.ok) {
        setError(body?.error ?? `Analyze error (${res.status})`);
        return;
      }
      setReport(body);
      setIdx(0);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-100">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="font-semibold">Game Review</div>
          <div className="flex-1" />
          {report && (
            <div className="flex items-center gap-3 text-sm">
              {scope === "both" ? (
                (() => {
                  const bySide = summarizeBySide(report.moves);
                  return (
                    <>
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500 mr-1">White</span>
                        <Pill tone="emerald" label="Great/Best" value={bySide.white.greatBest} />
                        <Pill tone="amber" label="Inacc." value={bySide.white.inaccuracies} />
                        <Pill tone="orange" label="Mistakes" value={bySide.white.mistakes} />
                        <Pill tone="red" label="Blunders" value={bySide.white.blunders} />
                      </div>
                      <div className="w-px h-5 bg-neutral-200 mx-1" />
                      <div className="flex items-center gap-2">
                        <span className="text-neutral-500 mr-1">Black</span>
                        <Pill tone="emerald" label="Great/Best" value={bySide.black.greatBest} />
                        <Pill tone="amber" label="Inacc." value={bySide.black.inaccuracies} />
                        <Pill tone="orange" label="Mistakes" value={bySide.black.mistakes} />
                        <Pill tone="red" label="Blunders" value={bySide.black.blunders} />
                      </div>
                    </>
                  );
                })()
              ) : (
                (() => {
                  const s = summarizeMoves(report.moves, scope);
                  return (
                    <>
                      <Pill tone="emerald" label="Great/Best" value={s.greatBest} />
                      <Pill tone="amber" label="Inacc." value={s.inaccuracies} />
                      <Pill tone="orange" label="Mistakes" value={s.mistakes} />
                      <Pill tone="red" label="Blunders" value={s.blunders} />
                    </>
                  );
                })()
              )}
            </div>
          )}
        </div>
      </header>

      {/* 2 columns */}
      <div className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[minmax(640px,1fr)_420px] gap-6">
        {/* LEFT: board + transport + PGN input + scope toggle */}
        <div>
          <div className="bg-white rounded-xl shadow-sm p-3 top-[72px]">
            <ChessBoardView
              fen={currentFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"}
              width={720}
            />

            <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <ScopeToggle scope={scope} setScope={setScope} disabled={!report} />
                <div className="text-xs font-mono text-neutral-500 truncate">
                  FEN: {currentFen || "(start)"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <NavBtn label="⟵" onClick={jumpPrev} disabled={!report || atFirst} />
                <div className="text-sm text-neutral-700 min-w-[150px] text-center">
                  {visiblePositions.length
                    ? `Move ${visiblePositions.indexOf(idx) + 1} / ${visiblePositions.length}`
                    : (report ? "No moves for this side" : "No game loaded")}
                </div>
                <NavBtn label="⟶" onClick={jumpNext} disabled={!report || atLast} />
              </div>
            </div>
          </div>

          {/* PGN input */}
          <div className="bg-white rounded-xl shadow-sm p-4 mt-6 space-y-3">
            <div className="text-sm font-medium">Paste PGN</div>
            <textarea
              className="w-full h-32 border rounded-md p-2 font-mono text-sm"
              placeholder="Paste full PGN here…"
              value={pgn}
              onChange={(e) => setPgn(e.target.value)}
            />
            <div className="flex items-center gap-3">
              <button
                onClick={runAnalyze}
                disabled={loading || !pgn.trim()}
                className="px-4 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {loading ? "Analyzing…" : "Analyze Game"}
              </button>
              {error && <div className="text-sm text-red-600">{error}</div>}
            </div>
          </div>
        </div>

        {/* RIGHT: Advice + scrollable move list */}
        <RightPanel
          report={report}
          idx={idx}
          setIdx={setIdx}
          scope={scope}
        />
      </div>
    </div>
  );
}

/* ------------------ Right Panel ------------------ */

function RightPanel({
  report,
  idx,
  setIdx,
  scope,
}: {
  report: Report | null;
  idx: number;
  setIdx: (n: number) => void;
  scope: Scope;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Build filtered rows + map to position index for clicks
  const rows = useMemo(() => {
    if (!report?.moves?.length) return [] as Array<{ m: MoveRow; posIndex: number }>;
    return report.moves
      .map((m, i) => ({ m, posIndex: i + 1 }))
      .filter((x) => scope === "both" || x.m.side === scope);
  }, [report, scope]);

  // Active move = move that led to current position
  const activeMove: MoveRow | undefined = report?.moves?.[idx - 1];

  // Auto-scroll active row into view
  useEffect(() => {
    const rowEl = listRef.current?.querySelector<HTMLButtonElement>(`[data-pos="${idx}"]`);
    if (rowEl) rowEl.scrollIntoView({ block: "nearest" });
  }, [idx, scope]);

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden flex flex-col">
      {/* Advice bar */}
      <div className="p-3 border-b bg-neutral-50">
        {/* ✅ pass the selected move */}
        <Advice move={activeMove} />
      </div>

      {/* Fixed-height list */}
      <div ref={listRef} className="p-3 h-[800px] overflow-auto">
        {rows.length ? (
          rows.map(({ m, posIndex }) => {
            const active = idx === posIndex;
            return (
              <button
                key={m.ply}
                data-pos={posIndex}
                onClick={() => setIdx(posIndex)}
                className={`w-full text-left px-3 py-2 rounded-lg border mb-2 transition min-h-[62px] ${active
                  ? "bg-emerald-50/60 border-emerald-200 ring-1 ring-emerald-200"
                  : "bg-white hover:bg-neutral-50 border-neutral-200"
                  }`}
              >
                <div className="flex items-center justify-between text-xs text-neutral-500">
                  <div className="font-medium">
                    {m.side === "white" ? "White" : "Black"} • Ply {m.ply}
                  </div>
                  <VerdictTag verdict={m.verdict} />
                </div>
                <div className="font-mono text-[13px] leading-5">
                  You: {m.san} ({m.uci}) &nbsp; • &nbsp; Best: {m.bestmove}
                  <span className="text-neutral-400"> &nbsp; • &nbsp; Δ {m.deltaCp} cp</span>
                </div>
              </button>
            );
          })
        ) : (
          <div className="text-sm text-neutral-500">
            {report ? "No moves for this side." : "Run an analysis to see moves."}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------ Advice ------------------ */

function Advice({ move }: { move?: MoveRow }) {
  if (!move) {
    return <div className="text-sm text-neutral-600">Pick a move to see feedback here.</div>;
  }

  const good = move.verdict === "Great" || move.verdict === "Good";
  const tone = good ? "emerald" : verdictTone(move.verdict);
  const delta = Math.abs(move.deltaCp);
  const better = move.better || move.bestmove; // 👈 prefer Gemini's suggestion

  return (
    <div className="flex items-start gap-3">
      <Dot tone={tone} />
      <div className="flex-1">
        <div className="text-sm font-semibold">
          {good ? "Nice move!" : `That was an ${move.verdict.toLowerCase()}.`}
        </div>
        <div className="text-sm text-neutral-700 mt-0.5">
          {good ? (
            <>You played one of the engine&rsquo;s top choices.</>
          ) : (
            <>
              Better was{" "}
              <code className="px-1.5 py-0.5 rounded bg-neutral-100 border text-[12px]">
                {better}
              </code>{" "}
              (~{delta} cp better).
            </>
          )}
        </div>

        {/* 👇 show Gemini’s explanation if present */}
        {!good && move.note && (
          <div className="text-sm text-neutral-600 mt-1">{move.note}</div>
        )}

        <div className="text-xs text-neutral-500 mt-1">
          Best eval: {signed(move.evalBestCp)} cp • After your move: {signed(move.evalHumanCp)} cp
        </div>
      </div>
    </div>
  );
}


/* ------------------ Small UI helpers ------------------ */

type Verdict = "Great" | "Good" | "Inaccuracy" | "Mistake" | "Blunder";

function summarizeMoves(moves: MoveRow[] = [], scope: Scope = "both") {
  const filtered = moves.filter(m => scope === "both" ? true : m.side === scope);
  const greatBest = filtered.filter(m => m.verdict === "Great" || m.verdict === "Good").length;
  const inaccuracies = filtered.filter(m => m.verdict === "Inaccuracy").length;
  const mistakes = filtered.filter(m => m.verdict === "Mistake").length;
  const blunders = filtered.filter(m => m.verdict === "Blunder").length;
  return { greatBest, inaccuracies, mistakes, blunders };
}

function summarizeBySide(moves: MoveRow[] = []) {
  return {
    white: summarizeMoves(moves, "white"),
    black: summarizeMoves(moves, "black"),
  };
}

function ScopeToggle({
  scope, setScope, disabled,
}: { scope: Scope; setScope: (s: Scope) => void; disabled?: boolean }) {
  const base = "px-3 py-1.5 text-sm rounded-md border";
  const on = "bg-emerald-600 text-white border-emerald-600";
  const off = "bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50";
  return (
    <div className="flex items-center gap-1">
      <button className={`${base} ${scope === "both" ? on : off}`} onClick={() => setScope("both")} disabled={disabled}>All</button>
      <button className={`${base} ${scope === "white" ? on : off}`} onClick={() => setScope("white")} disabled={disabled}>White</button>
      <button className={`${base} ${scope === "black" ? on : off}`} onClick={() => setScope("black")} disabled={disabled}>Black</button>
    </div>
  );
}

function Pill({ tone, label, value }: {
  tone: "emerald" | "amber" | "orange" | "red"; label: string; value: number;
}) {
  const m: Record<string, string> = {
    emerald: "bg-emerald-100 text-emerald-800 border-emerald-200",
    amber: "bg-amber-100 text-amber-800 border-amber-200",
    orange: "bg-orange-100 text-orange-800 border-orange-200",
    red: "bg-red-100 text-red-800 border-red-200",
  };
  return <div className={`px-2 py-0.5 text-xs rounded-md border ${m[tone]}`}>{label}: <b>{value ?? 0}</b></div>;
}

function VerdictTag({ verdict }: { verdict: MoveRow["verdict"] }) {
  const tone = verdictTone(verdict);
  const m: Record<string, string> = {
    emerald: "text-emerald-700 bg-emerald-100 border-emerald-200",
    cyan: "text-cyan-700 bg-cyan-100 border-cyan-200",
    amber: "text-amber-700 bg-amber-100 border-amber-200",
    orange: "text-orange-700 bg-orange-100 border-orange-200",
    red: "text-red-700 bg-red-100 border-red-200",
  };
  return <span className={`px-2 py-0.5 text-[11px] rounded border ${m[tone]}`}>{verdict}</span>;
}

function verdictTone(v: MoveRow["verdict"]): "emerald" | "cyan" | "amber" | "orange" | "red" {
  if (v === "Great") return "emerald";
  if (v === "Good") return "cyan";
  if (v === "Inaccuracy") return "amber";
  if (v === "Mistake") return "orange";
  return "red";
}

function Dot({ tone }: { tone: "emerald" | "cyan" | "amber" | "orange" | "red" }) {
  const c: Record<string, string> = {
    emerald: "bg-emerald-600",
    cyan: "bg-cyan-600",
    amber: "bg-amber-500",
    orange: "bg-orange-500",
    red: "bg-red-600",
  };
  return <div className={`w-2.5 h-2.5 rounded-full mt-2 ${c[tone]}`} />;
}

function signed(n: number) { return n > 0 ? `+${n}` : `${n}`; }
function countGreatBest(r: Report) { return r.moves.filter(m => m.verdict === "Great" || m.verdict === "Good").length; }

function NavBtn({ label, onClick, disabled }: {
  label: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-10 h-10 rounded-md border flex items-center justify-center bg-white hover:bg-neutral-50 disabled:opacity-40"
      aria-label={label}
    >
      {label}
    </button>
  );
}
