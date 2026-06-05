/**
 * All AI features, served directly by the Node server via Google Gemini.
 * (Replaces the former Python AI backend. Gemini is the only provider.)
 */
import { Router, type Request, type Response } from "express";
import { bowTopTerms } from "./src/lib/bow";

function geminiModel(): string {
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function envGeminiKey(): string {
  return (process.env.GEMINI_API_KEY || "").trim();
}

/** Resolve the Gemini key: per-request (from Settings) first, then env. */
function resolveGeminiKey(body: Record<string, unknown> | undefined): string {
  const fromBody =
    body && typeof body.gemini_api_key === "string" ? body.gemini_api_key.trim() : "";
  return fromBody || envGeminiKey();
}

class MissingKeyError extends Error {}

/** True when a Gemini error means "busy / try again" (503 overloaded, 429 rate limit). */
function isOverloadedError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit") ||
    msg.includes(" 503") ||
    msg.includes(" 429")
  );
}

function requireGeminiKey(body: Record<string, unknown> | undefined): string {
  const key = resolveGeminiKey(body);
  if (!key) {
    throw new MissingKeyError(
      "No Gemini API key configured. Add your key in Settings or set GEMINI_API_KEY in .env.local.",
    );
  }
  return key;
}

async function geminiGenerateText(
  prompt: string,
  apiKey: string,
  maxOutputTokens = 900,
  temperature = 0.6,
): Promise<string> {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${encodeURIComponent(geminiModel())}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens },
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let msg = "Gemini request failed.";
    try {
      const err = (await response.json()) as { error?: { message?: string } };
      if (err?.error?.message) msg = err.error.message;
    } catch {
      /* keep generic */
    }
    throw new Error(`Gemini error ${response.status}: ${msg}`);
  }
  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p?.text || "").join("").trim();
  return text || "No AI response was generated.";
}

function extractJsonObject(text: string): Record<string, any> | null {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* fall through */
      }
    }
  }
  return null;
}

async function validateGeminiKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    `${encodeURIComponent(geminiModel())}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts: [{ text: "Reply with exactly: OK" }] }],
    generationConfig: { maxOutputTokens: 16, temperature: 0 },
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { valid: true };
    let errorText = "Invalid API key or Gemini request failed.";
    try {
      const err = (await response.json()) as { error?: { message?: string } };
      if (err?.error?.message) errorText = err.error.message;
    } catch {
      /* keep generic */
    }
    return { valid: false, error: errorText };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { valid: false, error: `Network error: ${msg}` };
  }
}

// ---------- small helpers ported from the former Python backend ----------

function safeStr(val: unknown, def = ""): string {
  if (val === null || val === undefined) return def;
  const s = String(val).trim();
  return s || def;
}

function asInt(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function clampNum(v: unknown, lo: number, hi: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function timeHhmm(val: unknown, fallback: string): string {
  const s = safeStr(val, fallback);
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  return fallback;
}

// ---------- handler wrapper ----------

type Handler = (req: Request, res: Response) => Promise<void>;

/** Wrap a handler so a missing key → 400 and any other failure → the given fallback (502). */
function handle(fn: Handler, onError: (e: unknown) => { status: number; body: unknown }): Handler {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof MissingKeyError) {
        res.status(400).json({ message: error.message, text: error.message });
        return;
      }
      console.error(`AI route error (${req.path}):`, error);
      const { status, body } = onError(error);
      res.status(status).json(body);
    }
  };
}

// ---------- health-profile-suggest normalization ----------

function fallbackYogaPractices(issues: Set<string>): any[] {
  const out: any[] = [];
  if (issues.has("pcod")) {
    out.push({
      name: "Gentle spinal mobility",
      durationMinutes: 15,
      detail: "Cat-cow, easy twists, and side stretches — easy pace, no strain.",
    });
    out.push({
      name: "Restorative + breath",
      durationMinutes: 20,
      detail: "Supported child’s pose or legs-up-the-wall with slow nasal breathing for stress ease.",
    });
  }
  if (issues.has("weight_loss")) {
    out.push({
      name: "Active recovery flow",
      durationMinutes: 25,
      detail: "Sun salutations at a moderate pace plus hip openers to support walking or cardio days.",
    });
  }
  if (issues.has("weight_gain")) {
    out.push({
      name: "Mobility for lifting days",
      durationMinutes: 15,
      detail: "Shoulder circles, hip flexor lunges, and thoracic rotation before gym sessions.",
    });
  }
  if (!out.length) {
    out.push({
      name: "Easy full-body stretch",
      durationMinutes: 15,
      detail: "Neck rolls, standing side bends, and hamstring folds — breathe steadily.",
    });
  }
  return out.slice(0, 6);
}

function fallbackGymSuggestions(issues: Set<string>): any[] {
  const out: any[] = [];
  if (issues.has("pcod")) {
    out.push({
      name: "Moderate full-body strength",
      detail: "2–3 sets of compound moves (squat pattern, row, push) at RPE 6–7; stop if dizzy.",
      frequency: "2–3x/week",
    });
    out.push({
      name: "Low-impact cardio blocks",
      detail: "20–30 min brisk walk, incline treadmill, or cycle; consistency over intensity.",
      frequency: "3–5x/week",
    });
  }
  if (issues.has("weight_loss")) {
    out.push({
      name: "Strength + daily steps",
      detail: "2 full-body sessions/week plus a 30–45 min brisk walk most days.",
      frequency: "Strength 2x/week",
    });
  }
  if (issues.has("weight_gain")) {
    out.push({
      name: "Progressive resistance",
      detail: "Add a little weight or reps weekly on squat, hinge, push, pull; eat enough protein with meals.",
      frequency: "3x/week",
    });
  }
  if (!out.length) {
    out.push({
      name: "Starter full-body",
      detail: "Goblet squat, dumbbell row, push-ups or bench, plank — controlled tempo.",
      frequency: "2x/week",
    });
  }
  return out.slice(0, 6);
}

function clampTargets(raw: Record<string, any>): Record<string, number> {
  return {
    sleepHoursPerNight: clampNum(raw.sleepHoursPerNight, 5, 11, 8),
    waterGlassesPerDay: Math.round(clampNum(raw.waterGlassesPerDay, 4, 16, 8)),
    dailySteps: Math.round(clampNum(raw.dailySteps, 3000, 20000, 9000)),
    dailyCalorieTarget: Math.round(clampNum(raw.dailyCalorieTarget, 1200, 5000, 2000)),
    dailyTaskGoal: Math.round(clampNum(raw.dailyTaskGoal, 1, 20, 5)),
    weeklyWellnessSessions: Math.round(clampNum(raw.weeklyWellnessSessions, 1, 14, 3)),
  };
}

function normalizePersonalized(
  parsed: Record<string, any>,
  targets: Record<string, number>,
  dietPreference: string,
  specificFocusIssues: string[],
): Record<string, any> {
  const raw = (parsed.personalized && typeof parsed.personalized === "object" ? parsed.personalized : {}) as Record<string, any>;
  const sleepR = (raw.sleep && typeof raw.sleep === "object" ? raw.sleep : {}) as Record<string, any>;
  const hydR = (raw.hydration && typeof raw.hydration === "object" ? raw.hydration : {}) as Record<string, any>;
  const nutR = (raw.nutrition && typeof raw.nutrition === "object" ? raw.nutrition : {}) as Record<string, any>;
  const exR = (raw.exercise && typeof raw.exercise === "object" ? raw.exercise : {}) as Record<string, any>;
  const yogaR = (raw.yoga && typeof raw.yoga === "object" ? raw.yoga : {}) as Record<string, any>;
  const gymR = (raw.gym && typeof raw.gym === "object" ? raw.gym : {}) as Record<string, any>;

  const issuesNorm = new Set(
    (specificFocusIssues || [])
      .filter((x) => typeof x === "string" && x.trim())
      .map((x) => x.trim().toLowerCase()),
  );

  const glasses = targets.waterGlassesPerDay ?? 8;
  let g = Number(hydR.glassesPerDay);
  if (!Number.isFinite(g)) g = glasses;
  g = Math.max(4, Math.min(16, Math.round(g)));
  let ml = Number(hydR.totalMlApprox);
  if (!Number.isFinite(ml)) ml = g * 250;
  ml = Math.max(800, Math.min(6000, Math.round(ml)));

  const dietLabel = safeStr(nutR.dietStyleSuggested, dietPreference.replace(/_/g, " "));
  const bf = safeStr(nutR.breakfast, "Balanced breakfast aligned to your calories.");
  const lunch = safeStr(nutR.lunch, "Protein + vegetables + whole grain.");
  const dinner = safeStr(nutR.dinner, "Lighter evening meal, varied colors.");
  const snacks = safeStr(nutR.snacks, "");

  const sessionsOut: any[] = [];
  if (Array.isArray(exR.sessions)) {
    for (const item of exR.sessions.slice(0, 10)) {
      if (!item || typeof item !== "object") continue;
      let name = safeStr(item.name);
      const detail = safeStr(item.detail, name);
      if (!name && !detail) continue;
      if (!name) name = "Session";
      let dm: number | null = item.durationMinutes != null ? Number(item.durationMinutes) : null;
      dm = dm != null && Number.isFinite(dm) ? Math.max(5, Math.min(180, Math.round(dm))) : null;
      sessionsOut.push({
        name,
        durationMinutes: dm,
        frequency: safeStr(item.frequency, ""),
        detail: detail || "Adjust intensity to how you feel.",
      });
    }
  }
  if (!sessionsOut.length) {
    sessionsOut.push(
      {
        name: "Brisk walk or easy cardio",
        durationMinutes: 25,
        frequency: "5x/week",
        detail: "Build a steady habit before increasing intensity.",
      },
      {
        name: "Strength basics",
        durationMinutes: 20,
        frequency: "2x/week",
        detail: "Full-body moves (squat, push, pull, core) with light loads.",
      },
    );
  }

  const yogaOut: any[] = [];
  if (Array.isArray(yogaR.practices)) {
    for (const item of yogaR.practices.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      let name = safeStr(item.name);
      const detail = safeStr(item.detail, name);
      if (!name && !detail) continue;
      if (!name) name = "Practice";
      let dm: number | null = item.durationMinutes != null ? Number(item.durationMinutes) : null;
      dm = dm != null && Number.isFinite(dm) ? Math.max(5, Math.min(120, Math.round(dm))) : null;
      yogaOut.push({ name, durationMinutes: dm, detail: detail || "Move gently and breathe." });
    }
  }

  const gymOut: any[] = [];
  if (Array.isArray(gymR.suggestions)) {
    for (const item of gymR.suggestions.slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      let name = safeStr(item.name);
      const detail = safeStr(item.detail, name);
      if (!name && !detail) continue;
      if (!name) name = "Session";
      gymOut.push({
        name,
        detail: detail || "Adjust load to feel strong, not wiped out.",
        frequency: safeStr(item.frequency, "") || null,
      });
    }
  }

  const hasIssues = ["pcod", "weight_loss", "weight_gain"].some((i) => issuesNorm.has(i));

  const result: Record<string, any> = {
    sleep: {
      suggestedBedTime: timeHhmm(sleepR.suggestedBedTime, "22:30"),
      suggestedWakeTime: timeHhmm(sleepR.suggestedWakeTime, "06:30"),
      note: safeStr(sleepR.note, "") || null,
    },
    hydration: {
      glassesPerDay: g,
      totalMlApprox: ml,
      timingNote: safeStr(hydR.timingNote, "") || null,
    },
    nutrition: {
      dietStyleSuggested: dietLabel || "balanced",
      breakfast: bf,
      lunch,
      dinner,
      snacks: snacks || null,
    },
    exercise: {
      overview: safeStr(exR.overview, "") || null,
      sessions: sessionsOut,
    },
  };

  if (yogaOut.length) {
    result.yoga = { overview: safeStr(yogaR.overview, "") || null, practices: yogaOut };
  } else if (hasIssues) {
    result.yoga = {
      overview: "Tailored to your selected focus (general wellness, not medical advice).",
      practices: fallbackYogaPractices(issuesNorm),
    };
  }

  if (gymOut.length) {
    result.gym = { overview: safeStr(gymR.overview, "") || null, suggestions: gymOut };
  } else if (hasIssues) {
    result.gym = {
      overview: "Practical gym-style ideas aligned with your goals.",
      suggestions: fallbackGymSuggestions(issuesNorm),
    };
  }

  return result;
}

// ---------- router ----------

export function createAiRouter(): Router {
  const router = Router();

  router.post(
    "/suggestions",
    handle(
      async (req, res) => {
        const { module, data } = req.body;
        if (!module || !Array.isArray(data)) {
          res.status(400).json({ message: "module and data[] are required" });
          return;
        }
        const key = requireGeminiKey(req.body);
        const prompt =
          "You are a wellness and lifestyle coach.\n" +
          `Based on this ${module} data, provide exactly 3 short actionable suggestions.\n` +
          "Keep the tone encouraging and concise.\n" +
          "Format as numbered points.\n\n" +
          `Data: ${JSON.stringify(data)}`;
        const text = await geminiGenerateText(prompt, key);
        res.json({ text });
      },
      () => ({ status: 502, body: { text: "Failed to generate suggestions. Please try again later." } }),
    ),
  );

  router.post(
    "/thought-of-day",
    handle(
      async (req, res) => {
        const key = requireGeminiKey(req.body);
        const prompt =
          "Generate one unique, short, and powerful motivational quote for a lifestyle app. " +
          "Return only the quote text.";
        const text = await geminiGenerateText(prompt, key, 256);
        res.json({ text });
      },
      () => ({ status: 502, body: { text: "Every day is a new beginning." } }),
    ),
  );

  router.post(
    "/daily-coach",
    handle(
      async (req, res) => {
        const key = requireGeminiKey(req.body);
        const userName = req.body?.userName || "there";
        const modules = req.body?.modules || {};
        const hp = req.body?.health_profile ?? null;
        const hpLine = hp ? `\nUser health profile (goals & demographics): ${JSON.stringify(hp)}\n` : "";
        const prompt =
          "You are a personal daily wellness coach.\n" +
          `User name: ${userName}\n` +
          `Module data: ${JSON.stringify(modules)}\n` +
          `${hpLine}` +
          "Create a concise coaching response with:\n" +
          "1) One-line summary\n" +
          "2) Top 3 priorities for today\n" +
          "3) One simple win for next 30 minutes\n" +
          "Keep response practical. Align advice with their stated targets when relevant.";
        const text = await geminiGenerateText(prompt, key);
        res.json({ text });
      },
      () => ({ status: 502, body: { text: "Unable to generate your daily coaching plan right now." } }),
    ),
  );

  router.post(
    "/weekly-recap",
    handle(
      async (req, res) => {
        const key = requireGeminiKey(req.body);
        const modules = req.body?.modules || {};
        const hp = req.body?.health_profile ?? null;
        const hpLine = hp ? `\nUser health profile: ${JSON.stringify(hp)}\n` : "";
        const prompt =
          "You are a supportive wellness coach. Using the JSON data below (recent user logs across " +
          "sleep, nutrition, water, activity, tasks, and wellness), write a weekly recap.\n" +
          `${hpLine}` +
          "Structure your reply exactly as:\n" +
          "WEEK IN REVIEW: (one short paragraph, warm tone)\n" +
          "FOCUS NEXT WEEK:\n1. ...\n2. ...\n3. ...\n" +
          "If data is sparse, encourage logging and suggest gentle starter habits.\n\n" +
          `Data: ${JSON.stringify(modules)}`;
        const text = await geminiGenerateText(prompt, key);
        res.json({ text });
      },
      () => ({ status: 502, body: { text: "We could not build your weekly recap right now. Try again later." } }),
    ),
  );

  router.post(
    "/meal-estimate",
    handle(
      async (req, res) => {
        const { description, meal_type } = req.body;
        if (!description || typeof description !== "string") {
          res.status(400).json({ message: "description is required" });
          return;
        }
        const key = requireGeminiKey(req.body);
        const prompt =
          "Estimate typical nutrition for this meal. Return ONLY a compact JSON object with keys:\n" +
          '"calories" (integer kcal), "protein" (integer grams), "vitamins" (string, brief nutrient highlights).\n' +
          "No markdown, no explanation outside JSON.\n\n" +
          `Meal type hint: ${meal_type || "meal"}\nDescription: ${description}`;
        const text = await geminiGenerateText(prompt, key);
        const parsed = extractJsonObject(text);
        if (!parsed) {
          res.json({
            calories: null,
            protein: null,
            vitamins: null,
            note: "Could not parse model output; try again or enter manually.",
          });
          return;
        }
        res.json({
          calories: asInt(parsed.calories),
          protein: asInt(parsed.protein),
          vitamins: safeStr(parsed.vitamins) || null,
        });
      },
      () => ({
        status: 502,
        body: { calories: null, protein: null, vitamins: null, note: "Meal estimate failed. Try again." },
      }),
    ),
  );

  router.post(
    "/wellness-reflect",
    handle(
      async (req, res) => {
        const { content, entry_type } = req.body;
        if (!content || typeof content !== "string") {
          res.status(400).json({ message: "content is required" });
          return;
        }
        const key = requireGeminiKey(req.body);
        const contentBow = bowTopTerms(content.trim(), 12);
        const bowHint = Object.keys(contentBow).length
          ? `\nBag-of-words term counts from the entry (use with full text, not instead of it): ${JSON.stringify(contentBow)}\n`
          : "";
        const prompt =
          "The user wrote a short wellness journal entry in a self-care app.\n" +
          `Entry type: ${entry_type || "gratitude"} (gratitude or affirmation).\n` +
          `Text: ${content}\n` +
          `${bowHint}\n` +
          "Respond in three short labeled parts (plain text, no JSON):\n" +
          "Summary: one warm sentence reflecting what they shared.\n" +
          "Encouragement: one gentle sentence (not clinical; not therapy).\n" +
          "Next prompt: one idea for what they could journal next time.\n" +
          "If the text suggests self-harm, severe distress, or crisis, replace your reply with a brief " +
          "message to reach out to a trusted person, local emergency services, or a crisis line — " +
          "and do not give coaching tips.";
        const text = await geminiGenerateText(prompt, key);
        res.json({ text });
      },
      () => ({ status: 502, body: { text: "Reflection is unavailable right now. Please try again later." } }),
    ),
  );

  // Always responds 200 so the client can branch on { overloaded } / { error } / data.
  router.post("/mood-support", async (req, res) => {
    try {
      const { mood, score, note } = req.body || {};
      if (!mood || typeof mood !== "string") {
        res.status(400).json({ error: "mood is required" });
        return;
      }
      let key: string;
      try {
        key = requireGeminiKey(req.body);
      } catch {
        res.json({ error: "Add a Gemini API key in Settings to get AI guidance." });
        return;
      }
      const moodNorm = mood.trim().toLowerCase() || "neutral";
        const noteStr = typeof note === "string" ? note.trim() : "";
        const noteBow = noteStr ? bowTopTerms(noteStr, 12) : {};
        const bowHint = Object.keys(noteBow).length
          ? `\nBag-of-words term counts from their note (use with the full text, not instead of it): ${JSON.stringify(noteBow)}\n`
          : "";
        const noteLine = noteStr ? `What they wrote: ${noteStr}\n` : "";
        const scoreLine =
          Number.isFinite(Number(score)) ? `Positivity score (0-100, higher is better): ${Number(score)}\n` : "";
        const prompt =
          "A user of a self-care app just completed a Mood Check.\n" +
          `Detected mood: ${moodNorm}.\n` +
          `${scoreLine}${noteLine}${bowHint}\n` +
          "Respond ONLY with a compact JSON object (no markdown) shaped exactly:\n" +
          "{\n" +
          '  "suggestions": [3 short, practical, personalized suggestions as strings],\n' +
          '  "activities": [2 short mood-improvement activities they can do right now as strings],\n' +
          '  "motivation": "one warm, encouraging sentence"\n' +
          "}\n" +
          "Keep it supportive, specific, and non-clinical (you are a coach, not a therapist or doctor). " +
          "If their note suggests self-harm, a crisis, or severe distress, set every suggestion and " +
          "activity to gently encourage reaching out to a trusted person, local emergency services, or a " +
          "crisis line, and make motivation a caring message — do not give ordinary coaching tips.";
      const text = await geminiGenerateText(prompt, key, 600);
      const parsed = extractJsonObject(text);
      if (!parsed) {
        res.json({ error: "Could not read the AI response. Please try again." });
        return;
      }
      const asStrList = (val: unknown, limit: number): string[] => {
        if (!Array.isArray(val)) return [];
        const out: string[] = [];
        for (const item of val) {
          const s = safeStr(item);
          if (s) out.push(s);
          if (out.length >= limit) break;
        }
        return out;
      };
      res.json({
        suggestions: asStrList(parsed.suggestions, 4),
        activities: asStrList(parsed.activities, 3),
        motivation: safeStr(parsed.motivation),
      });
    } catch (error) {
      if (isOverloadedError(error)) {
        res.json({ overloaded: true });
        return;
      }
      console.error("AI mood-support route error:", error);
      res.json({ error: "AI guidance is unavailable right now. Please try again." });
    }
  });

  router.post(
    "/chat-assistant",
    handle(
      async (req, res) => {
        const { message, history } = req.body;
        if (!message || typeof message !== "string") {
          res.status(400).json({ message: "message is required" });
          return;
        }
        const key = requireGeminiKey(req.body);
        const turns = Array.isArray(history) ? history.slice(-12) : [];
        const historyLines: string[] = [];
        for (const turn of turns) {
          const role = safeStr(turn?.role).toLowerCase();
          const content = safeStr(turn?.content);
          if ((role !== "user" && role !== "assistant") || !content) continue;
          historyLines.push(`${role.toUpperCase()}: ${content}`);
        }
        const prompt =
          "You are Blueberry Assistant, a helpful in-app wellness assistant.\n" +
          "Rules:\n" +
          "- Answer clearly and briefly.\n" +
          "- Focus on this app's features: sleep, nutrition, hydration, activity, wellness, tasks, settings.\n" +
          "- If user asks medical advice, give a safe non-diagnostic response.\n" +
          "- Use bullets when helpful.\n\n" +
          `Conversation history:\n${historyLines.join("\n")}\n\n` +
          `USER: ${message.trim()}\nASSISTANT:`;
        const text = await geminiGenerateText(prompt, key, 700);
        res.json({ text });
      },
      () => ({ status: 502, body: { text: "Chat assistant is unavailable right now. Please try again." } }),
    ),
  );

  router.post("/validate-llm-config", async (req, res) => {
    try {
      const key = typeof req.body?.gemini_api_key === "string" ? req.body.gemini_api_key.trim() : "";
      const effectiveKey = key || envGeminiKey();
      if (!effectiveKey) {
        res.json({ valid: false, error: "Gemini API key is empty." });
        return;
      }
      const result = await validateGeminiKey(effectiveKey);
      res.json(result);
    } catch (error) {
      console.error("AI validate-llm-config route error:", error);
      res.status(502).json({ valid: false, error: "Could not validate the Gemini API key." });
    }
  });

  router.post(
    "/health-profile-suggest",
    handle(
      async (req, res) => {
        const b = req.body || {};
        const age = Number(b.age);
        const heightCm = Number(b.height_cm);
        const weightKg = Number(b.weight_kg);
        if (!Number.isFinite(age) || age < 10 || age > 110) {
          res.status(400).json({ message: "valid age is required" });
          return;
        }
        if (typeof b.gender !== "string" || !b.gender.trim()) {
          res.status(400).json({ message: "gender is required" });
          return;
        }
        if (!Number.isFinite(heightCm) || heightCm < 50 || heightCm > 300) {
          res.status(400).json({ message: "valid height_cm is required" });
          return;
        }
        if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400) {
          res.status(400).json({ message: "valid weight_kg is required" });
          return;
        }
        if (typeof b.activity_level !== "string" || !b.activity_level.trim()) {
          res.status(400).json({ message: "activity_level is required" });
          return;
        }
        const key = requireGeminiKey(req.body);

        const dietPref = safeStr(b.diet_preference, "no_preference") || "no_preference";
        const allowed = new Set(["pcod", "weight_loss", "weight_gain"]);
        const issues: string[] = (Array.isArray(b.specific_focus_issues) ? b.specific_focus_issues : [])
          .filter((x: unknown): x is string => typeof x === "string" && allowed.has(x.trim()))
          .map((x: string) => x.trim());

        const userBlob: Record<string, any> = {
          age: Math.round(age),
          gender: b.gender.trim(),
          height_cm: heightCm,
          weight_kg: weightKg,
          activity_level: b.activity_level.trim(),
          primary_focus: Array.isArray(b.primary_focus) ? b.primary_focus : [],
          specific_focus_issues: issues,
          notes: typeof b.notes === "string" ? b.notes : "",
          diet_preference: dietPref,
        };
        const notesBow = bowTopTerms(userBlob.notes || "", 15);
        if (Object.keys(notesBow).length) userBlob.notes_bag_of_words = notesBow;
        const bowLine = Object.keys(notesBow).length
          ? "\nUser JSON may include notes_bag_of_words: Bag-of-Words (term frequency) counts from optional " +
            "coach notes. Combine with the full notes text; higher counts indicate repeated themes.\n"
          : "";
        const issuesLine = issues.length
          ? "\nThe user selected one or more self-reported focus areas (not diagnoses): " +
            `${JSON.stringify(issues)}. Tailor the plan accordingly:\n` +
            '- For "pcod": favor balanced meals with steady energy (e.g. protein + fiber at meals), ' +
            "hydration spread through the day with a timing note, gentle stress-friendly yoga, " +
            "and moderate gym work (avoid extreme dieting language; encourage clinician follow-up " +
            "for medical concerns).\n" +
            '- For "weight_loss": meals that support sustainable deficit-friendly patterns, ' +
            "hydration clarity, yoga for recovery/mobility, gym mix of strength + manageable cardio.\n" +
            '- For "weight_gain": nutrient-dense meals, adequate hydration, yoga for mobility around ' +
            "lifting, gym focused on progressive resistance.\n"
          : "";

        const prompt =
          "You are a supportive lifestyle coach (not a doctor). Given the user's self-reported data, " +
          "propose realistic daily targets AND a concrete personalized plan. Do not diagnose.\n" +
          "Respect diet_preference strictly for meal ideas: vegetarian / vegan / eggetarian / " +
          "non_vegetarian / no_preference. Label dietStyleSuggested clearly (e.g. 'Vegetarian', " +
          "'Non-vegetarian', 'Mixed').\n" +
          `${issuesLine}${bowLine}\n` +
          `User JSON: ${JSON.stringify(userBlob)}\n\n` +
          "Return ONLY valid JSON (no markdown) with this shape:\n" +
          "{\n" +
          '  "targets": { same numeric targets as before: sleepHoursPerNight, waterGlassesPerDay, ' +
          "dailySteps, dailyCalorieTarget, dailyTaskGoal, weeklyWellnessSessions },\n" +
          '  "summary": "2-3 sentences",\n' +
          '  "tips": { "sleep", "nutrition", "water", "activity", "wellness", "tasks" },\n' +
          '  "personalized": {\n' +
          '    "sleep": { "suggestedBedTime": "HH:MM 24h", "suggestedWakeTime": "HH:MM 24h", "note": "short" },\n' +
          '    "hydration": { "glassesPerDay": number, "totalMlApprox": number, ' +
          '"timingNote": "when to drink more; align with any selected specific_focus_issues" },\n' +
          '    "nutrition": { "dietStyleSuggested": "string", "breakfast": "specific meal idea", ' +
          '"lunch": "specific meal idea", "dinner": "specific meal idea", "snacks": "optional string" },\n' +
          '    "exercise": { "overview": "one sentence", "sessions": [\n' +
          '        { "name": "string", "durationMinutes": number, "frequency": "e.g. 3x/week", "detail": "what to do" }\n' +
          "      ] },\n" +
          '    "yoga": { "overview": "one sentence", "practices": [\n' +
          '        { "name": "string", "durationMinutes": number, "detail": "poses / pacing / breath" }\n' +
          "      ] },\n" +
          '    "gym": { "overview": "one sentence", "suggestions": [\n' +
          '        { "name": "string", "detail": "what to do", "frequency": "e.g. 3x/week" }\n' +
          "      ] }\n" +
          "  }\n" +
          "}\n" +
          "Provide at least 3 exercise sessions tailored to age, weight, and activity_level. " +
          "If specific_focus_issues is non-empty, include at least 2 yoga practices and 2 gym suggestions " +
          "explicitly aligned with those issues. Meals must be specific (ingredients-style), not vague.";

        const text = await geminiGenerateText(prompt, key, 2800);
        const parsed = extractJsonObject(text);
        if (!parsed) {
          res.status(502).json({ message: "Could not parse AI response. Try again or set targets manually." });
          return;
        }
        if (!parsed.targets || typeof parsed.targets !== "object") {
          res.status(502).json({ message: "Invalid targets in AI response." });
          return;
        }
        const targets = clampTargets(parsed.targets);
        const summary = safeStr(parsed.summary) || "Here are some starter targets tailored to you.";
        const tips: Record<string, string> = {};
        if (parsed.tips && typeof parsed.tips === "object") {
          for (const [k, v] of Object.entries(parsed.tips)) {
            if (typeof k === "string" && typeof v === "string" && v.trim()) tips[k] = v.trim();
          }
        }
        const personalized = normalizePersonalized(parsed, targets, dietPref, issues);
        personalized.hydration.glassesPerDay = targets.waterGlassesPerDay;
        personalized.hydration.totalMlApprox = Math.max(
          personalized.hydration.totalMlApprox,
          targets.waterGlassesPerDay * 240,
        );
        res.json({ targets, summary, tips, personalized });
      },
      () => ({
        status: 502,
        body: { message: "Could not generate suggestions. Check the AI backend and API key." },
      }),
    ),
  );

  return router;
}
