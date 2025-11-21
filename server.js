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

// OpenAI: metti la chiave in OPENAI_API_KEY (env su Render)
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());

// Sessioni in memoria: { count, wizard: { budget, countryCode, weeks, goal } }
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

/* ------------------- PARSING & HEURISTICHE ------------------- */

function parseBudget(text) {
  const match = text.toLowerCase().match(/(\d[\d\.'’]*\d|\d+)/);
  if (!match) return null;
  const value = parseInt(match[0].replace(/[^\d]/g, ""), 10);
  return isNaN(value) ? null : value;
}

function parseCountryCode(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes("usa") ||
    lower.includes("stati uniti") ||
    lower.includes("stato unito") ||
    lower.includes("america")
  ) {
    return "us";
  }
  if (lower.includes("canada") || lower.includes("canadà")) {
    return "canada";
  }
  return null;
}

function parseWeeks(text) {
  const lower = text.toLowerCase();

  if (lower.includes("estate")) return 12;
  if (lower.includes("semestre")) return 24;
  if (lower.includes("anno")) return 48;

  const match = lower.match(/(\d+)\s*(settimane|sett\.?|mesi|mese)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (match[2].startsWith("mes")) {
      // mesi -> ~4 settimane
      return num * 4;
    }
    return num;
  }

  return null;
}

function isProgramIntent(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("usa") ||
    lower.includes("canada") ||
    lower.includes("programma") ||
    lower.includes("all'estero") ||
    lower.includes("estero") ||
    lower.includes("semestre") ||
    lower.includes("anno") ||
    lower.includes("summer") ||
    lower.includes("exchange") ||
    parseBudget(text) !== null
  );
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

    // recupera / crea sessione
    let session = sessions.get(sessionId);
    if (!session) {
      session = { count: 0, wizard: {} };
      sessions.set(sessionId, session);
    }

    // limite messaggi free
    if (session.count >= MAX_MESSAGES_FREE) {
      return res.json({
        type: "limit_reached",
        reply:
          "Hai usato tutte le domande gratuite per esplorare i programmi. " +
          "Per salvare questa comparazione e continuare senza limiti, [[CREA_UN_ACCOUNT]].",
        ctaUrl: ""
      });
    }
    session.count += 1;

    const text = String(message || "").trim();
    const wizard = session.wizard || (session.wizard = {});

    // 1) Popola automaticamente eventuali parametri dal messaggio corrente
    const detectedBudget = parseBudget(text);
    if (detectedBudget && !wizard.budget) wizard.budget = detectedBudget;

    const detectedCountry = parseCountryCode(text);
    if (detectedCountry && !wizard.countryCode) {
      wizard.countryCode = detectedCountry;
    }

    const detectedWeeks = parseWeeks(text);
    if (detectedWeeks && !wizard.weeks) wizard.weeks = detectedWeeks;

    // 2) Se abbiamo già budget+paese+durata ma NON abbiamo ancora goal,
    //    e questo messaggio NON ha appena impostato budget/paese/durata,
    //    allora trattiamo il testo come risposta all'obiettivo.
    if (
      wizard.budget &&
      wizard.countryCode &&
      wizard.weeks &&
      !wizard.goal &&
      !detectedBudget &&
      !detectedCountry &&
      !detectedWeeks
    ) {
      wizard.goal = text;
    }

    const wizardActive =
      wizard.budget || wizard.countryCode || wizard.weeks || wizard.goal;

    // 3) Se non stiamo ancora parlando di programmi e non c'è wizard attivo -> LLM generico
    if (!wizardActive && !isProgramIntent(text)) {
      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content:
              "Sei Edovia AI, un assistente che spiega come funziona un comparatore di programmi di studio all'estero. " +
              "Rispondi in modo chiaro e sintetico. Quando l'utente parla di budget, Paesi o programmi, guida verso la comparazione."
          },
          { role: "user", content: text }
        ]
      });

      const reply =
        completion.choices?.[0]?.message?.content ||
        "C'è stato un problema, riprova tra poco.";

      return res.json({ type: "ok", reply });
    }

    /* --------- WIZARD GUIDATO: budget -> paese -> durata -> obiettivo --------- */

    if (!wizard.budget) {
      const reply =
        "Perfetto, ti aiuto a confrontare i programmi all’estero.\n\n" +
        "Per farlo mi servono 4 informazioni:\n" +
        "1. Il **budget totale** (corso + alloggio)\n" +
        "2. Il **Paese** che preferisci\n" +
        "3. La **durata** (es. estate, semestre, anno)\n" +
        "4. Il tuo **obiettivo** (cosa vuoi ottenere dal viaggio)\n\n" +
        "Partiamo dal budget: **quanto puoi spendere in totale?** 💶\n" +
        "_Esempio: 8.000€, 10.000 euro, 12k..._";
      return res.json({ type: "ok", reply });
    }

    if (!wizard.countryCode) {
      const reply =
        `Ok, budget indicativo: **circa €${wizard.budget}**.\n\n` +
        "Ora scegli la destinazione principale che vuoi confrontare:\n\n" +
        "• 🇺🇸 **USA** (città come Boston, New York, Los Angeles, San Diego)\n" +
        "• 🇨🇦 **Canada** (Toronto, Vancouver, ecc.)\n\n" +
        "Scrivi ad esempio: _USA_ oppure _Canada_.";
      return res.json({ type: "ok", reply });
    }

    if (!wizard.weeks) {
      const reply =
        "Perfetto. Che **durata** hai in mente? ⏱️\n\n" +
        "Puoi rispondere in settimane oppure scegliere una di queste opzioni:\n" +
        "• _Estate_: 8–12 settimane\n" +
        "• _Semestre_: 24 settimane\n" +
        "• _Anno_: 48 settimane\n\n" +
        "Ad esempio: _24 settimane_, _semestre_, _3 mesi_, _anno intero_.";
      return res.json({ type: "ok", reply });
    }

    if (!wizard.goal) {
      const reply =
        "Ultimo passo: qual è il tuo **obiettivo principale** per questo periodo all’estero? 🎯\n\n" +
        "Puoi scrivere in modo libero, oppure ispirarti a questi esempi:\n" +
        "• Migliorare l’inglese per **università** o **lavoro**\n" +
        "• Fare un’esperienza **culturale** e di crescita personale\n" +
        "• Preparare esami come **IELTS** o **TOEFL**\n" +
        "• Capire se in futuro potrei **trasferirmi** in quel Paese\n\n" +
        "Scrivi in una frase cosa ti aspetti dal viaggio.";
      return res.json({ type: "ok", reply });
    }

    // a questo punto abbiamo tutto: budget + countryCode + weeks + goal
    const countryCode = wizard.countryCode;
    const countryLabel = countryCode === "us" ? "USA" : "Canada";
    const flag = countryCode === "us" ? "🇺🇸" : "🇨🇦";

    const programs = comparePrograms({
      countryCode,
      budget: wizard.budget,
      weeks: wizard.weeks
    });

    if (programs.length) {
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
        const blocks = Math.round((score / 5) * 10);
        const filled = "▰".repeat(blocks);
        const empty = "▱".repeat(10 - blocks);
        return filled + empty;
      }

      function badgeArray(p, score) {
        const result = [];

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
        const score = matchScore(p.total, wizard.budget);
        const tags = badgeArray(p, score);

        return [
          `${flag}  OPZIONE ${index + 1}`,
          "",
          `Match: ${stars(score)}  (${score.toFixed(1)}/5)`,
          `${bar(score)}`,
          "",
          `🏫  ${p.name}`,
          `📍  ${p.city}`,
          `🕒  Durata stimata: ${wizard.weeks} settimane`,
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
        `In base al tuo obiettivo **“${wizard.goal.trim()}”**, al budget di circa **€${wizard.budget}** ` +
        `e alla durata di **${wizard.weeks} settimane** in **${countryLabel}**, ` +
        `ecco le opzioni che Edovia ha trovato per te:\n\n` +
        "────────────────────────────────────────\n\n" +
        cards.join("\n\n") +
        "\n\n👉 Per vedere i dettagli completi, salvare la comparazione e procedere con l'application, [[CREA_UN_ACCOUNT]].";

      // resettiamo il wizard per una nuova ricerca
      session.wizard = {};

      return res.json({
        type: "ok",
        reply
      });
    }

    // Nessun partner trovato -> messaggio di fallback
    const fallbackReply =
      "Per i parametri che hai inserito non trovo partner compatibili nei Paesi selezionati. " +
      "Possiamo provare a:\n" +
      "• Aumentare un po’ il budget\n" +
      "• Ridurre la durata\n" +
      "• Valutare un altro Paese (es. Canada invece di USA)\n\n" +
      "Dimmi cosa preferisci modificare e rifacciamo il confronto.";
    return res.json({ type: "ok", reply: fallbackReply });
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

