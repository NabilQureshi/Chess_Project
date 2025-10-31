// coach.js
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

// Optional: tiny LLM helper. Safe to run with no API key.
let model = null;
try {
    if (process.env.GEMINI_API_KEY) {
        const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        model = ai.getGenerativeModel({
            model: process.env.GEMINI_MODEL || "gemini-2.0-flash-lite",
        });
    } else {
        console.warn("GEMINI_API_KEY not set; explainBadMove will be a no-op.");
    }
} catch (err) {
    console.error("Failed to initialize Gemini model:", err?.message || err);
}

// Verdicts based on eval swing in centipawns.
// Positive delta means your move was worse than best by that many cp.
export function verdictFromDeltaCp(deltaCp) {
    const d = Math.abs(deltaCp ?? 0);
    if (d >= 200) return "Blunder";
    if (d >= 80) return "Mistake";
    if (d >= 30) return "Inaccuracy";
    return "Okay";
}

function safeParseJson(s) {
    if (!s) return {};
    s = s.replace(/^```json\s*/i, "").replace(/```$/i, "");
    try { return JSON.parse(s); } catch { return {}; }
}

// Returns { note?: string, better?: string } for non-Okay moves.
// If no API key, returns {}.
export async function explainBadMove({ san, evalBeforeCp, evalAfterCp, deltaCp, verdict }) {
    if (!model || verdict === "Okay") return {};
    const prompt = `
Explain in <=2 short sentences why ${san} was bad given eval change (${evalBeforeCp}→${evalAfterCp}, Δ=${deltaCp}cp),
and suggest one better idea. Return strict JSON: {"note": string, "better": string}
  `.trim();

    try {
        const r = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
        });
        const text = r?.response?.text?.() ?? "";
        return safeParseJson(text);
    } catch {
        return {};
    }
}
