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

// Configura OpenAI: la chiave va in OPENAI_API_KEY (env su Render)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());

// memoria in RAM per conteggio messaggi per sessione (ok per demo)
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

// prova a capire se il messaggio chiede una comparazione (budget + paese)
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

  const weeks = 24; // per ora assumiamo "semestre" = 24 settimane

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

    // conteggio messaggi per sessionId
    const current = sessions.get(sessionId) || 0;
    if (current >= MAX_MESSAGES_FREE) {
      return res.json({
        type: "limit_reached",
        reply:
          "Hai usato tutte le domande gratuite per esplorare i programmi. " +
          "Per salvare questa comparazione e continuare senza limiti, CREA UN ACCOUNT Edovia.",
        ctaUrl: "" // per ora nessun link, solo testo
      });
    }
    sessions.set(sessionId, current + 1);

    // 1) Se il messaggio contiene budget + paese, prova a usare il comparatore
    const comparisonIntent = parseIntentForComparison(message);
    if (comparisonIntent) {
      const { budget, countryCode, weeks } = comparisonIntent;
      const programs = comparePrograms({ countryCode, budget, weeks });

      if (programs.length) {
        const countryLabel = countryCode === "us" ? "USA" : "Canada";

        const lines = programs.slice(0, 3).map((p) => {
          return [
            `**${p.name} – ${p.city}**`,
            `Totale stimato semestre (${weeks} settimane): ~€${Math.round(
              p.total
            )}`,
            `• Corso: ~€${Math.round(p.tuition)}`,
            `• Alloggio: ~€${Math.round(p.housing)}`,
            `• Altre spese e fee: ~€${Math.round(p.fees)}`,
            p.fitsBudget
              ? "✅ Entro il tuo budget"
              : "⚠️ Potrebbe superare il budget indicato",
            `Nota: ${p.notes}`
          ].join("\n");
        });

        const reply =
          `Ecco una comparazione sintetica di alcuni partner in **${countryLabel}** in base al tuo budget:\n\n` +
          lines.join("\n\n---\n\n") +
          "\n\n👉 Per vedere i dettagli completi, salvare la comparazione e procedere con l'application, **CREA UN ACCOUNT**.";

        return res.json({
          type: "ok",
          reply
        });
      }
      // se non troviamo partner, si continua con la logica LLM sotto
    }

    // 2) Altrimenti usa l'LLM "generico" come prima
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Sei Edovia AI, un comparatore di programmi di studio e formazione all'estero. " +
            "Rispondi in modo breve, concreto, e guida l'utente a confrontare programmi, costi e requisiti. " +
            "Quando possibile, invita l'utente a fare comparazioni tra programmi e Paesi diversi."
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const reply =
      completion.choices?.[0]?.message?.content ??
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

