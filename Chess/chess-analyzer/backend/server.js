// server.js
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import Stockfish from "stockfish.wasm";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Chess } from "chess.js";
import { LRUCache } from "lru-cache";
import { verdictFromDeltaCp, explainBadMove } from "./coach.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));

// ---- WASM load (avoid fetch on Windows paths)
const wasmPath = join(__dirname, "node_modules", "stockfish.wasm", "stockfish.wasm");
const engine = await Stockfish({ wasmBinary: readFileSync(wasmPath) });

// ---- Initialize engine once
async function initEngine() {
    await new Promise((resolve) => {
        const on = (l) => {
            if (String(l).includes("uciok")) {
                engine.removeMessageListener(on);
                resolve();
            }
        };
        engine.addMessageListener(on);
        engine.postMessage("uci");
    });
    await new Promise((resolve) => {
        const on = (l) => {
            if (String(l).includes("readyok")) {
                engine.removeMessageListener(on);
                resolve();
            }
        };
        engine.addMessageListener(on);
        engine.postMessage("isready");
    });
    engine.postMessage("setoption name Threads value 2");
    engine.postMessage("setoption name Hash value 256");
}
await initEngine();

// ---- Simple in-process queue so calls don't overlap
const queue = [];
let busy = false;
function enqueue(fn) {
    return new Promise((res, rej) => {
        queue.push({ fn, res, rej });
        pump();
    });
}
async function pump() {
    if (busy || queue.length === 0) return;
    busy = true;
    const { fn, res, rej } = queue.shift();
    try { res(await fn()); } catch (e) { rej(e); } finally { busy = false; pump(); }
}

// ---- Helpers
const evalCache = new LRUCache({ max: 10_000 });

function normalizePgn(raw) {
    if (!raw) return "";
    let s = String(raw);
    s = s.replace(/^\uFEFF/, "");         // BOM
    s = s.replace(/\u200B/g, "");         // zero-width space
    s = s.replace(/\u00A0/g, " ");        // NBSP → space
    s = s.replace(/\u2013|\u2014/g, "-"); // en/em dash → hyphen
    s = s.replace(/\u2026/g, "...");      // ellipsis
    s = s.replace(/\r/g, "\n");

    // Strip headers [Tag "..."]
    s = s.replace(/\[.*?\]\s*/gs, "");
    // Strip comments/variations
    s = s.replace(/\{[^}]*\}/g, " ");
    s = s.replace(/\([^)]*\)/g, " ");
    // Strip NAGs like $1
    s = s.replace(/\$\d+/g, " ");
    // Normalize castling zeros
    s = s.replace(/\b0-0-0\b/gi, "O-O-O").replace(/\b0-0\b/gi, "O-O");
    // Remove results
    s = s.replace(/\b(1-0|0-1|1\/2-1\/2|\*)\b/g, " ");
    // Normalize "12..." -> "12."
    s = s.replace(/(\d+)\.(\.\.)/g, "$1.");
    // Collapse whitespace
    s = s.replace(/[ \t]+/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    return s;
}

function parseGameLoose(pgn) {
    const clean = normalizePgn(pgn);
    const g = new Chess();
    const ok = g.loadPgn(clean, { sloppy: true });
    if (ok) return g;

    // Fallback: token-by-token SAN parsing
    const tmp = new Chess();
    const body = clean
        .replace(/\{[^}]*\}/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\$\d+/g, " ")
        .trim();

    const tokens = body.split(/\s+/);
    let moves = 0;

    for (const t0 of tokens) {
        const t = t0.trim();
        if (!t) continue;
        if (/^\d+(\.{1,3})?$/.test(t)) continue; // move numbers
        if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) break;
        try { tmp.move(t, { sloppy: true }); moves++; } catch { }
    }
    if (moves === 0) return null;
    return tmp;
}

function toCp(score) {
    if (!score) return 0;
    if (score.type === "mate") return score.value > 0 ? 100000 : -100000;
    return score.value;
}

function analyzeFen({ fen, depth = 16, multipv = 3, movetime }) {
    return enqueue(() => new Promise((resolve) => {
        const lines = new Map();
        let bestmove = null;

        const onMsg = (raw) => {
            const line = String(raw).trim();
            if (line.startsWith("info ")) {
                const mMV = line.match(/\bmultipv (\d+)/);
                if (mMV) lines.set(Number(mMV[1]), line);
            } else if (line.startsWith("bestmove")) {
                bestmove = line.split(/\s+/)[1];
                engine.removeMessageListener(onMsg);

                const candidates = Array.from(lines.entries())
                    .sort((a, b) => a[0] - b[0])
                    .map(([mv, l]) => {
                        const depthSeen = Number(l.match(/\bdepth (\d+)/)?.[1] ?? 0);
                        const mMate = l.match(/\bscore mate (-?\d+)/);
                        const mCp = l.match(/\bscore cp (-?\d+)/);
                        const pv = l.match(/\bpv (.+)$/)?.[1]?.trim().split(/\s+/) ?? [];
                        const score = mMate
                            ? { type: "mate", value: Number(mMate[1]) }
                            : { type: "cp", value: Number(mCp?.[1] ?? 0) };
                        return { rank: mv, depth: depthSeen, score, pv };
                    });

                resolve({ bestmove, candidates });
            }
        };

        engine.addMessageListener(onMsg);
        engine.postMessage("ucinewgame");
        engine.postMessage(`position fen ${fen}`);
        engine.postMessage(`setoption name MultiPV value ${multipv}`);
        engine.postMessage(movetime ? `go movetime ${movetime}` : `go depth ${depth}`);
    }));
}

async function analyzeFenCached({ fen, depth = 16, multipv = 3, movetime }) {
    const key = `${fen}|${depth}|${multipv}|${movetime || 0}`;
    if (evalCache.has(key)) return evalCache.get(key);
    const out = await analyzeFen({ fen, depth, multipv, movetime });
    evalCache.set(key, out);
    return out;
}

// ---- Routes

app.post("/parse", (req, res) => {
    try {
        const { pgn } = req.body || {};
        if (typeof pgn !== "string" || pgn.trim() === "") {
            return res.status(400).json({ error: "pgn (non-empty string) required" });
        }
        const game = parseGameLoose(pgn);
        if (!game) return res.status(400).json({ error: "Invalid PGN after normalize" });
        return res.json({ ok: true, moves: game.history().length });
    } catch (e) {
        console.error("PARSE ROUTE ERROR:", e);
        return res.status(500).json({ error: e?.message || "parse error" });
    }
});

app.post("/analyze", async (req, res) => {
    const { fen, depth, multipv, movetime } = req.body || {};
    if (!fen) return res.status(400).json({ error: "fen required" });
    try {
        const out = await analyzeFen({ fen, depth, multipv, movetime });
        res.json(out);
    } catch (e) {
        res.status(500).json({ error: e.message || "engine error" });
    }
});

app.post("/analyzeGame", async (req, res) => {
    try {
        const {
            pgn,
            depth = 16,
            multipv = 3,
            movetime,
            withCoach = false, // set true to get tiny per-move LLM notes
        } = req.body || {};

        if (!pgn || typeof pgn !== "string") {
            return res.status(400).json({ error: "pgn (string) required" });
        }

        const game = parseGameLoose(pgn);
        if (!game) {
            return res.status(400).json({ error: "Invalid PGN after normalize" });
        }

        const verboseMoves = game.history({ verbose: true });
        const replay = new Chess();
        const rows = [];

        for (let i = 0; i < verboseMoves.length; i++) {
            const mv = verboseMoves[i];

            const fenBefore = replay.fen();
            const side = replay.turn() === "w" ? "white" : "black";
            const humanUci = mv.from + mv.to + (mv.promotion || "");
            const humanSan = mv.san;

            // Engine before (best line and its eval, side-to-move POV)
            const engBefore = await analyzeFenCached({ fen: fenBefore, depth, multipv, movetime });
            const bestmove = engBefore.bestmove;
            const evalBestCp = toCp(engBefore.candidates?.[0]?.score);

            // After human move (flip eval back to side-to-move POV)
            const tmp = new Chess(fenBefore);
            tmp.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
            const fenAfterHuman = tmp.fen();

            const engAfter = await analyzeFenCached({ fen: fenAfterHuman, depth, multipv: 1, movetime });
            const evalHumanCpOpp = toCp(engAfter.candidates?.[0]?.score);
            const evalHumanCp = -evalHumanCpOpp;

            // Positive delta = how much worse your move was vs best
            const deltaCp = evalBestCp - evalHumanCp;
            const verdict = verdictFromDeltaCp(deltaCp);

            const row = {
                ply: i + 1,
                side,
                san: humanSan,
                uci: humanUci,
                fenBefore,
                fenAfter: fenAfterHuman,
                bestmove,
                evalBestCp,
                evalHumanCp,
                deltaCp,
                verdict, // "Okay" | "Inaccuracy" | "Mistake" | "Blunder"
            };

            // Optional tiny LLM note/better suggestion for non-Okay moves
            if (withCoach && verdict !== "Okay") {
                const extra = await explainBadMove({
                    san: humanSan,
                    evalBeforeCp: evalBestCp,
                    evalAfterCp: evalHumanCp,
                    deltaCp,
                    verdict,
                });
                if (extra?.note) row.note = extra.note;
                if (extra?.better) row.better = extra.better;
            }

            rows.push(row);
            replay.move(mv);
        }

        const summary = {
            inaccuracies: rows.filter(r => r.verdict === "Inaccuracy").length,
            mistakes: rows.filter(r => r.verdict === "Mistake").length,
            blunders: rows.filter(r => r.verdict === "Blunder").length,
        };

        res.json({ moves: rows, summary });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message || "analysis error" });
    }
});

app.listen(process.env.PORT || 8080, () =>
    console.log(`Backend listening on :${process.env.PORT || 8080}`)
);
