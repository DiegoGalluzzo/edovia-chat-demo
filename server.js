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

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());

// sessione: { count, wizard: { started, budget, countryCode, weeks, goal } }
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

/* ------------------- PARSING ------------------- */

/**
 * Interpreta un budget dal testo.
 * - accetta numeri con contesto monetario (€, euro, eur, k, mila)
 * - oppure numeri "grandi" (>= 100) anche senza simboli
 * - ignora numeri piccoli in contesti non monetari (es. "1 anno", "3 mesi")
 */
function parseBudget(text) {
  const lower = text.toLowerCase();

  const hasCurrency =
    lower.includes("€") ||
    lower.includes("euro") ||
    lower.includes(" eur") ||
    lower.includes(" k") || // es. "10k"
    lower.includes(" mila"); // es. "10 mila"

  const match = lower.match(/(\d[\d\.'’]*\d|\d+)/);
  if (!match) return null;

  const value = parseInt(match[0].replace(/[^\d]/g, ""), 10);
  if (isNaN(value)) return null;

  // Se non c'è contesto monetario, escludo numeri piccoli (tipicamente durate)
  if (!hasCurrency && value < 100) {
    return null;
  }

  return value;
}

/**
 * Riconosce il Paese sia da parole chiave che da città tipiche.
 */
function parseCountryCode(text) {
  const lower = text.toLowerCase();

  // parole generiche
  if (
    lower.includes("usa") ||
    lower.includes("stati uniti") ||
    lower.includes("america")
  ) {
    return "us";
  }
  if (lower.includes("canada") || lower.includes("canadà")) {
    return "canada";
  }

  // città tipiche USA
  if (
    lower.includes("boston") ||
    lower.includes("new york") ||
    lower.includes("los angeles") ||
    lower.includes("san diego")
  ) {
    return "us";
  }

  // città tipiche Canada
  if (
    lower.includes("toronto") ||
    lower.includes("vancouver") ||
    lower.includes("montreal") ||
    lower.includes("calgary")
  ) {
    return "canada";
  }

  return null;
}

/**
 * Interpreta la durata in settimane, partendo da parole chiave
 * (estate/semestre/anno) o espressioni tipo "3 mesi", "24 settimane".
 */
function parseWeeks(text) {
  const lower = text.toLowerCase();

  if (lower.includes("estate") || lower.includes("summer")) return 12;
  if (lower.includes("semestre") || lower.includes("semester")) return 24;
  if (lower.includes("anno") || lower.includes("year")) return 48;

  const match = lower.match(/(\d+)\s*(settimane|sett\.?|weeks?|mesi|mese|months?)/);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2];
    if (unit.startsWith("mes") || unit.startsWith("month")) {
      return num * 4;
    }
    return num;
  }

  return null;
}

/**
 * Riconosce un "goal" di massima dal testo:
 * esperienza culturale, crescita personale, lavoro, università, esami, ecc.
 */
function parseGoal(text) {
  const lower = text.toLowerCase();

  if (
    lower.includes("cultur") ||
    lower.includes("cresc") ||
    lower.includes("personal") ||
    lower.includes("univers") ||
    lower.includes("lavor") ||
    lower.includes("inglese") ||
    lower.includes("toefl") ||
    lower.includes("ielts") ||
    lower.includes("accadem")
  ) {
    return text.trim();
  }

  return null;
}

/**
 * Riconosce se il messaggio dell'utente parla di programmi/viaggi.
 */
function isProgramIntent(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("usa") ||
    lower.includes("canada") ||
    lower.includes("all'estero") ||
    lower.includes("anno") ||
    lower.includes("semestre") ||
    lower.includes("exchange") ||
    lower.includes("programma") ||
    lower.includes("programmi") ||
    parseBudget(text) !== null
  );
}

/* ------------------- UTIL ------------------- */

function naturalJoin(list) {
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const head = list.slice(0, -1).join(", ");
  return head + " e " + list[list.length - 1];
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

    let session = sessions.get(sessionId);
    if (!session) {
      session = { count: 0, wizard: { started: false } };
      sessions.set(sessionId, session);
    }

    if (session.count >= MAX_MESSAGES_FREE) {
      const reply =
        "Hai usato tutte le domande gratuite per esplorare i programmi. Per salvare questa comparazione e continuare senza limiti, [[CREA_UN_ACCOUNT]]";
      return res.json({
        type: "limit_reached",
        reply,
        ctaUrl: ""
      });
    }
    session.count += 1;

    const text = String(message || "").trim();
    const wizard = session.wizard || (session.wizard = { started: false });

    // auto-parsing parametri dal testo corrente
    const detectedBudget = parseBudget(text);
    const detectedCountry = parseCountryCode(text);
    const detectedWeeks = parseWeeks(text);
    const detectedGoal = parseGoal(text);

    if (detectedBudget && !wizard.budget) wizard.budget = detectedBudget;
    if (detectedCountry && !wizard.countryCode) wizard.countryCode = detectedCountry;
    if (detectedWeeks && !wizard.weeks) wizard.weeks = detectedWeeks;
    if (detectedGoal && !wizard.goal) wizard.goal = detectedGoal;

    const wizardActive =
      wizard.budget || wizard.countryCode || wizard.weeks || wizard.goal;

    // se non stiamo facendo il wizard e il messaggio non parla di programmi -> LLM generico
    if (!wizardActive && !isProgramIntent(text)) {
      const systemPrompt =
        "Sei Edovia AI, un assistente che spiega come funziona un comparatore AI di programmi di studio all'estero. Rispondi in modo chiaro e sintetico, sempre in italiano. Quando l'utente parla di budget, Paesi o programmi, guidalo verso la comparazione. Non usare markdown o asterischi, solo testo semplice con a capo.";

      const completion = await client.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          { role: "user", content: text }
        ]
      });

      let reply =
        completion.choices?.[0]?.message?.content ||
        "C'è stato un problema, riprova tra poco.";

      // rimozione eventuali asterischi residui
      reply = reply.replace(/\*/g, "");

      return res.json({ type: "ok", reply });
    }

    // da qui in poi: flusso wizard

    wizard.started = true;

    const missingBudget = !wizard.budget;
    const missingCountry = !wizard.countryCode;
    const missingWeeks = !wizard.weeks;
    const missingGoal = !wizard.goal;

    // se manca almeno un parametro -> chiedi solo ciò che manca, in modo conversazionale
    if (missingBudget || missingCountry || missingWeeks || missingGoal) {
      const knownParts = [];

      if (wizard.countryCode) {
        const l = wizard.countryCode === "us" ? "USA" : "Canada";
        knownParts.push(`destinazione: ${l}`);
      }
      if (wizard.weeks) {
        knownParts.push(`durata: circa ${wizard.weeks} settimane`);
      }
      if (wizard.budget) {
        knownParts.push(`budget indicativo: circa €${wizard.budget}`);
      }
      if (wizard.goal) {
        knownParts.push(`obiettivo: ${wizard.goal}`);
      }

      let intro = "";
      if (knownParts.length) {
        intro = "Ok, finora ho capito " + naturalJoin(knownParts) + ".\n\n";
      } else {
        intro =
          "Perfetto, ti aiuto a confrontare i programmi all’estero.\nPuoi rispondere anche in modo libero, ad esempio: \"Ho 9000 euro per un anno negli USA per fare un’esperienza culturale\".\n\n";
      }

      let question = "";

      if (missingBudget) {
        question =
          "Partiamo dal budget totale che hai a disposizione per corso + alloggio. Quanto puoi spendere in totale? Puoi scrivere, ad esempio: 8000 euro, 10000, 12000...";
      } else if (missingCountry) {
        question =
          "Ora scegli il Paese di destinazione che vuoi confrontare: ad esempio USA oppure Canada. Se hai già in mente una città (es. Boston, San Diego, Toronto), puoi scriverla.";
      } else if (missingWeeks) {
        question =
          "Che durata hai in mente? Puoi rispondere in settimane oppure scrivere: estate, semestre, anno. Ad esempio: 24 settimane, 3 mesi, un anno intero.";
      } else if (missingGoal) {
        question =
          "Ultimo passo: qual è il tuo obiettivo principale per questo periodo all’estero? Puoi scrivere in modo libero, ad esempio: esperienza culturale e di crescita personale, migliorare l’inglese per l’università, preparare esami come IELTS o TOEFL, capire se potrei trasferirmi in quel Paese.";
      }

      const reply = intro + question;
      return res.json({ type: "ok", reply });
    }

    // abbiamo budget + countryCode + weeks + goal: facciamo la comparazione

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
          result.push("[Lifestyle e outdoor]");
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

        const lines = [
          `${flag}  OPZIONE ${index + 1}`,
          "",
          `Match: ${stars(score)}  (${score.toFixed(1)}/5)`,
          `${bar(score)}`,
          "",
          `Scuola: ${p.name}`,
          `Città: ${p.city}`,
          `Durata stimata: ${wizard.weeks} settimane`,
          "",
          `Totale stimato: €${Math.round(p.total)}`,
          `  • Corso: €${Math.round(p.tuition)}`,
          `  • Alloggio: €${Math.round(p.housing)}`,
          `  • Fee e altre spese: €${Math.round(p.fees)}`,
          "",
          `Tag: ${tags.join("  ")}`,
          "",
          `Nota: ${p.notes}`,
          "",
          "────────────────────────────────────────"
        ];

        return lines.join("\n");
      });

      const header = `In base al tuo obiettivo "${wizard.goal.trim()}", al budget di circa €${wizard.budget} e alla durata di ${wizard.weeks} settimane in ${countryLabel}, ecco le principali opzioni che Edovia ha trovato per te:\n\n`;

      const cta =
        "Per vedere i dettagli completi, salvare la comparazione e procedere con l'application, [[CREA_UN_ACCOUNT]]";

      const reply =
        header +
        "────────────────────────────────────────\n\n" +
        cards.join("\n\n");

      // reset wizard per eventuale nuova ricerca
      session.wizard = { started: false };

      return res.json({
        type: "ok",
        reply
      });
    }

    const fallbackReply =
      "Per i parametri che hai inserito non trovo partner compatibili nei Paesi selezionati. Possiamo provare a:\n• Aumentare un po’ il budget\n• Ridurre la durata\n• Valutare un altro Paese (ad esempio Canada invece di USA)\n\nDimmi cosa preferisci modificare e rifacciamo il confronto.";
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

