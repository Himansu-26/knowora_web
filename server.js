import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const COOKIE_SECRET = process.env.COOKIE_SECRET || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
// Use a model ID enabled for your Google AI Studio key. Override this in Render if needed.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(allowed.includes(file.mimetype) ? null : new Error("Please use a JPG, PNG or WEBP image."), allowed.includes(file.mimetype));
  }
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const identifyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

function sign(value) {
  return crypto.createHmac("sha256", COOKIE_SECRET).update(value).digest("hex");
}
function authed(req) {
  if (!COOKIE_SECRET || !ACCESS_CODE) return false;
  const raw = req.cookies.knowora_session || "";
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(payload));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now();
  } catch { return false; }
}
function requireAuth(req, res, next) {
  if (!authed(req)) return res.status(401).json({ error: "Please unlock your private Knowora site first." });
  next();
}

app.post("/api/login", loginLimiter, (req, res) => {
  if (!ACCESS_CODE || !COOKIE_SECRET) return res.status(503).json({ error: "Private access is not configured yet. Add ACCESS_CODE and COOKIE_SECRET in your backend settings." });
  const submitted = String(req.body?.code || "");
  const a = Buffer.from(submitted);
  const b = Buffer.from(ACCESS_CODE);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "That access code did not match." });
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString("base64url");
  res.cookie("knowora_session", `${payload}.${sign(payload)}`, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
    maxAge: 30 * 24 * 60 * 60 * 1000, path: "/"
  });
  res.json({ ok: true });
});
app.post("/api/logout", (_req, res) => {
  res.clearCookie("knowora_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/status", (req, res) => res.json({ authenticated: authed(req) }));

const SYSTEM_PROMPT = `You are Knowora, a careful visual explainer. Identify the main subject in the image. Return ONLY valid JSON with these keys:
name, category, confidence (0-100), shortDescription, usesOrPurpose, howItWorksOrBehaves, characteristics (array of strings), habitatAndFood (string), careOrSafety (string), canBePurchased (boolean or null), approximatePriceIndia (string), whereToFind (string), conservation (string), funFacts (array of strings), similarThings (array of strings), uncertainty (string).
For animals/plants: never imply wild animals can be kept or bought; explain legal/ethical restrictions and conservation. For products: prices must be clearly approximate and avoid invented live listings or shopping links. If the image is unclear, say so and lower confidence. Do not identify people. Do not infer dangerous uses. Keep the response educational, concise, and suitable for students.`;

app.post("/api/identify", requireAuth, identifyLimiter, upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose or take one photo first." });
  if (!GEMINI_API_KEY) return res.status(503).json({ fallback: true, error: "AI is not connected yet. Add GEMINI_API_KEY in Render. Your photo was not sent anywhere." });
  try {
    // Exactly one Gemini generateContent request for each uploaded photo. No automatic retry.
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [
          { text: "Identify the main thing in this photo and explain it for Knowora. Reply in the required JSON format." },
          { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString("base64") } }
        ] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.25, maxOutputTokens: 1400 }
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("Gemini request failed:", response.status, detail.slice(0, 500));
      return res.status(502).json({ fallback: true, error: "Knowora could not get an AI result right now. Check the model name, API key or quota, then try again later." });
    }
    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    const result = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, "").trim());
    result.name = String(result.name || "Unknown item").slice(0, 120);
    result.category = String(result.category || "Unclassified").slice(0, 80);
    result.confidence = Math.max(0, Math.min(100, Number(result.confidence) || 0));
    if (supabase) {
      const { error } = await supabase.from("identifications").insert({
        item_name: result.name, category: result.category, confidence: result.confidence,
        result: result, created_at: new Date().toISOString()
      });
      if (error) console.error("Supabase save issue:", error.message);
    }
    res.json({ result, saved: Boolean(supabase) });
  } catch (error) {
    console.error("Identify error:", error.message);
    res.status(502).json({ fallback: true, error: "The identification service is temporarily unavailable. Your site is still working; try again later or use Search." });
  }
});

app.get("/api/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (!q) return res.json({ results: [] });
  if (!supabase) return res.json({ results: [], note: "Database search becomes available after Supabase is connected." });
  const { data, error } = await supabase.from("identifications")
    .select("item_name, category, confidence, created_at")
    .ilike("item_name", `%${q.replace(/[%_]/g, "")}%`)
    .order("created_at", { ascending: false }).limit(8);
  if (error) return res.json({ results: [], note: "Saved-search service is temporarily unavailable." });
  res.json({ results: data || [] });
});

app.get("/api/history", requireAuth, async (_req, res) => {
  if (!supabase) return res.json({ items: [], configured: false });
  const { data, error } = await supabase.from("identifications").select("id,item_name,category,confidence,created_at")
    .order("created_at", { ascending: false }).limit(12);
  if (error) return res.json({ items: [], configured: true });
  res.json({ items: data || [], configured: true });
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "Knowora" }));
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "That feature is not available." });
  res.sendFile(path.join(__dirname, "public", "index.html"), err => err && next(err));
});
app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(400).json({ error: err.message || "Something went wrong. Please try again." });
});

app.listen(PORT, () => console.log(`Knowora listening on ${PORT}`));