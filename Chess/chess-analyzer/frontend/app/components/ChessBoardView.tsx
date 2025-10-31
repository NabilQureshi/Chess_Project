// app/components/ChessBoardView.tsx
"use client";
import dynamic from "next/dynamic";
import { useMemo } from "react";
import { Chess } from "chess.js";

// v5 component (type as any to avoid TS prop friction)
const Chessboard = dynamic<any>(
    () => import("react-chessboard").then((m) => m.Chessboard),
    { ssr: false }
);

// Normalize/validate a FEN (fallback to start if bad)
function cleanFen(raw: string) {
    const s = (raw ?? "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
    try { return new Chess(s).fen(); } catch {
        return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    }
}

export default function ChessBoardView({
    fen,
    width = 520,
}: { fen: string; width?: number }) {
    const safeFen = useMemo(() => cleanFen(fen), [fen]);

    const options = useMemo(
        () => ({
            id: "analysis-board",
            position: safeFen,
            draggable: { enabled: false },
            animation: { enabled: false },
        }),
        [safeFen]
    );

    // Force repaint on FEN change if needed
    const key = `board-${safeFen}-${width}`;

    return (
        <div className="flex justify-center">
            <Chessboard key={key} options={options} width={width} />
            {/* If your build only accepts boardWidth, you can also pass boardWidth={width} */}
        </div>
    );
}
