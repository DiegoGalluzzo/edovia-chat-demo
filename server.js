import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;

// OpenAI: chiave in OPENAI_API_KEY (Render env)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());

// Conteggio messaggi per sessione (demo)
const sessions = new Map();
const MAX_MESSAGES_FREE = 20;

/* ------------------- PARTNER & COMPARATORE ------------------- */

function loadPartners(countryCode) {
  try {
    const filePath = path.join(__dirname, "partners", `${countryCode}.json`);
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Errore caricando partners per", countryCode, err.message);
    return [];
  }
}

function comparePrograms({ countryCode, budget, weeks }) {
  const partners = loadPartners(countryCode);
  if (!partners.length) return [];

  return partners
    .map((p) => {
      const tuition = p.tuition_per_week * weeks;
      const housing = p.housing_per_week * weeks;
      const total = tuition + housing + p.fees;

      return {
        ...p,
        total,
        tuition,
        housing,
        fitsBudget: total <= budget
      };
    })
    .sort((a, b) => a.total - b.total);
}

// Estrae intento di comparazione: budget + paese
function parseIntentForComparison(message) {
  const lower = message.toLowerCase();

  // budget tipo "8.000", "8000", "10'000"
  const budgetMatch = lower.match(/(\d[\d\.'’]*\d|\d+)/);
  const budget = budgetMatch
    ? parseInt(budgetMatch[0].replace(/[^\d]/g, ""), 10)
    : null;

  let countryCode = null;
  if (
    lower.includes("usa") ||
    lower.includes("stati uniti") ||
    lower.includes("stato unito")
  ) {
    countryCode = "us";
  } else if (lower.includes("canada") || lower.includes("canadà")) {
    countryCode = "canada";
  }

  const weeks = 24; // per ora: semestre = 24 settimane

  if (!budget || !countryCode) {
    return null;
  }

  return { budget, countryCode, weeks };
}

/* ------------------------- ROUTE CHAT ------------------------- */

app.post("/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res
        .status(400)
        .json({ error: "sessionId e message sono obbligatori" });
    }

    // Limite messaggi free per sessione
    const current = sessions.get(sessionId) || 0;
    if (current >= MAX_MESSAGES_FREE) {
      return res.json({
        type: "limit_reached",
        reply:
          "Hai usato tutte le domande gratuite per esplorare i programmi. " +
          "Per salvare questa comparazione e continuare senza limiti, CREA UN ACCOUNT Edovia.",
        ctaUrl: "" // per ora nessun link
      });
    }
    sessions.set(sessionId, current + 1);

    // 1) Se messaggio contiene budget + paese, usa comparatore
    const comparisonIntent = parseIntentForComparison(message);
    if (comparisonIntent) {
      const { budget, countryCode, weeks } = comparisonIntent;
      const programs = comparePrograms({ countryCode, budget, weeks });

      if (programs.length) {
        const countryLabel = countryCode === "us" ? "USA" : "Canada";
        const flag = countryCode === "us" ? "🇺🇸" : "🇨🇦";

        // Punteggio di match basato sul budget
        function matchScore(total, budget) {
          const diff = total - budget;
          if (diff <= 0) return 5.0;
          const ratio = diff / budget;
          if (ratio < 0.1) return 4.5;
          if (ratio < 0.2) return 4.0;
          if (ratio < 0.3) return 3.5;
          if (ratio < 0.5) return 3.0;
          return 2.5;
        }

        function stars(score) {
          const full = Math.floor(score);
          const empty = 5 - full;
          return "★".repeat(full) + "☆".repeat(empty);
        }

        function bar(score) {
          // score 0–5 -> 0–10 blocchi
          const blocks = Math.round((score / 5) * 10);
          const filled = "▰".repeat(blocks);
          const empty = "▱".repeat(10 - blocks);
          return filled + empty;
        }

        function badgeArray(p, score) {
          const result = [];

          // budget
          if (p.fitsBudget) {
            result.push("[Budget ok]");
          } else {
            result.push("[Sopra budget]");
          }

          const cityLower = (p.city || "").toLowerCase();
          if (cityLower.includes("boston") || cityLower.includes("new york")) {
            result.push("[Focus accademico]");
          }
          if (
            cityLower.includes("los angeles") ||
            cityLower.includes("san diego") ||
            cityLower.includes("vancouver")
          ) {
            result.push("[Lifestyle & outdoor]");
          }
          if (cityLower.includes("toronto")) {
            result.push("[Grande città]");
          }

          // match
          if (score >= 4.5) {
            result.push("[Match molto alto]");
          } else if (score >= 4.0) {
            result.push("[Buon match]");
          } else if (score >= 3.5) {
            result.push("[Compromesso budget]");
          } else {
            result.push("[Usa come riferimento]");
          }

          return result;
        }

        const cards = programs.slice(0, 3).map((p, index) => {
          const score = matchScore(p.total, budget);
          const tags = badgeArray(p, score);

          return [
            `${flag}  OPZIONE ${index + 1}`,
            "",
            `Match: ${stars(score)}  (${score.toFixed(1)}/5)`,
            `${bar(score)}`,
            "",
            `🏫  ${p.name}`,
            `📍  ${p.city}`,
            `🕒  Semestre: ${weeks} settimane`,
            "",
            `💵  Totale stimato: €${Math.round(p.total)}`,
            `    • Corso: €${Math.round(p.tuition)}`,
            `    • Alloggio: €${Math.round(p.housing)}`,
            `    • Fee e altre spese: €${Math.round(p.fees)}`,
            "",
            `🔖  Tag: ${tags.join("  ")}`,
            "",
            `📌  ${p.notes}`,
            "",
            "────────────────────────────────────────"
          ].join("\n");
        });

        const reply =
          `Ecco le **3 opzioni principali** che Edovia ha trovato per te in **${countryLabel}**.\n` +
          `I costi sono stime per un semestre (24 settimane) corso + alloggio:\n\n` +
          cards.join("\n\n") +
          "\n\n👉 Per vedere i dettagli completi, salvare la comparazione e procedere con l'application, **CREA UN ACCOUNT**.";

        return res.json({
          type: "ok",
          reply
        });
      }
      // se non troviamo partner, si passa all'LLM normale
    }

    // 2) Altrimenti: risposta generica via LLM
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Sei Edovia AI, un comparatore di programmi di studio e formazione all'estero. " +
            "Rispondi in modo breve, concreto e orientato alla scelta del programma. " +
            "Quando ha senso, suggerisci di confrontare Paesi e tipologie diverse."
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "C'è stato un problema, riprova tra poco.";

    res.json({
      type: "ok",
      reply
    });
  } catch (err) {
    console.error("Errore /chat:", err);
    res.status(500).json({ error: "Errore server" });
  }
});

app.get("/", (req, res) => {
  res.send("Edovia chat demo è attiva");
});

app.listen(port, () => {
  console.log(`Edovia chat demo in ascolto sulla porta ${port}`);
});

