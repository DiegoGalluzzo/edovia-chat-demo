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

// sessione: { count, lang, wizard: { budget, countryCode, weeks, goal } }
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

/* ------------------- PARSING & LINGUA ------------------- */

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

function isProgramIntent(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("usa") ||
    lower.includes("canada") ||
    lower.includes("exchange") ||
    lower.includes("all'estero") ||
    lower.includes("abroad") ||
    lower.includes("programma") ||
    lower.includes("program") ||
    lower.includes("semestre") ||
    lower.includes("semester") ||
    lower.includes("anno") ||
    lower.includes("year") ||
    parseBudget(text) !== null
  );
}

// rilevazione super semplice IT/EN
function detectLanguage(text) {
  const lower = text.toLowerCase();
  const italianHints = [
    "ciao",
    "studiare",
    "all'estero",
    "università",
    "anno",
    "settimane",
    "euro",
    "paese",
    "durata",
    "budget",
    "crescita",
    "personale",
    "scuola",
    "superiori"
  ];
  let score = 0;
  italianHints.forEach((w) => {
    if (lower.includes(w)) score++;
  });
  if (score >= 2) return "it";
  return "en";
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
      session = { count: 0, lang: null, wizard: {} };
      sessions.set(sessionId, session);
    }

    if (session.count >= MAX_MESSAGES_FREE) {
      const reply =
        session.lang === "en"
          ? "You have used all the free questions to explore programs. To save this comparison and continue without limits, [[CREA_UN_ACCOUNT]]."
          : "Hai usato tutte le domande gratuite per esplorare i programmi. Per salvare questa comparazione e continuare senza limiti, [[CREA_UN_ACCOUNT]].";
      return res.json({
        type: "limit_reached",
        reply,
        ctaUrl: ""
      });
    }
    session.count += 1;

    const text = String(message || "").trim();

    // lingua: fissiamo alla prima occasione
    if (!session.lang) {
      session.lang = detectLanguage(text);
    }
    const lang = session.lang || "it";

    const wizard = session.wizard || (session.wizard = {});

    // auto-parsing parametri dal testo corrente
    const detectedBudget = parseBudget(text);
    if (detectedBudget && !wizard.budget) wizard.budget = detectedBudget;

    const detectedCountry = parseCountryCode(text);
    if (detectedCountry && !wizard.countryCode) {
      wizard.countryCode = detectedCountry;
    }

    const detectedWeeks = parseWeeks(text);
    if (detectedWeeks && !wizard.weeks) wizard.weeks = detectedWeeks;

    // se abbiamo già tutto tranne goal, e questo messaggio non è stato interpretato come budget/paese/durata -> trattalo come goal
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

    // se non stiamo facendo il wizard e il messaggio non parla di programmi -> LLM generico
    if (!wizardActive && !isProgramIntent(text)) {
      const systemPrompt =
        lang === "en"
          ? "You are Edovia AI, an assistant that explains how an AI-powered study abroad comparison tool works. Answer clearly and briefly. When the user talks about budget, countries or programs, guide them to compare options. Always answer in the same language as the user and do not use markdown or asterisks, just plain text with line breaks."
          : "Sei Edovia AI, un assistente che spiega come funziona un comparatore AI di programmi di studio all'estero. Rispondi in modo chiaro e sintetico. Quando l'utente parla di budget, Paesi o programmi, guidalo verso la comparazione. Rispondi sempre nella stessa lingua dell'utente e non usare markdown o asterischi, solo testo semplice con a capo.";

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
        (lang === "en"
          ? "There was a problem, please try again in a moment."
          : "C'è stato un problema, riprova tra poco.");

      // rimozione eventuali asterischi residui
      reply = reply.replace(/\*/g, "");

      return res.json({ type: "ok", reply });
    }

    /* --------- WIZARD: budget -> paese -> durata -> obiettivo --------- */

    if (!wizard.budget) {
      const reply =
        lang === "en"
          ? "Great, I can help you compare study abroad programs.\n\nTo do that I need 4 pieces of information:\n1. Your total budget (course + accommodation)\n2. Your preferred country\n3. The duration (e.g., summer, semester, year)\n4. Your main goal for this experience\n\nLet’s start with the budget: how much can you spend in total? 💶\nExample: 8000, 10000 euros, 12000..."
          : "Perfetto, ti aiuto a confrontare i programmi all’estero.\n\nPer farlo mi servono 4 informazioni:\n1. Il budget totale (corso + alloggio)\n2. Il Paese che preferisci\n3. La durata (es. estate, semestre, anno)\n4. Il tuo obiettivo principale per il viaggio\n\nPartiamo dal budget: quanto puoi spendere in totale? 💶\nEsempio: 8000, 10000 euro, 12000...";
      return res.json({ type: "ok", reply });
    }

    if (!wizard.countryCode) {
      const reply =
        lang === "en"
          ? `OK, so your budget is about €${wizard.budget}.\n\nNow choose the main destination you want to compare:\n\n• USA (cities like Boston, New York, Los Angeles, San Diego)\n• Canada (Toronto, Vancouver, etc.)\n\nWrite for example: USA or Canada.`
          : `Ok, budget indicativo: circa €${wizard.budget}.\n\nOra scegli la destinazione principale che vuoi confrontare:\n\n• USA (città come Boston, New York, Los Angeles, San Diego)\n• Canada (Toronto, Vancouver, ecc.)\n\nScrivi ad esempio: USA oppure Canada.`;
      return res.json({ type: "ok", reply });
    }

    if (!wizard.weeks) {
      const reply =
        lang === "en"
          ? "Great. What duration do you have in mind? ⏱️\n\nYou can answer in weeks or pick one of these options:\n• Summer: 8–12 weeks\n• Semester: 24 weeks\n• Year: 48 weeks\n\nFor example: 24 weeks, semester, 3 months, full year."
          : "Perfetto. Che durata hai in mente? ⏱️\n\nPuoi rispondere in settimane oppure scegliere una di queste opzioni:\n• Estate: 8–12 settimane\n• Semestre: 24 settimane\n• Anno: 48 settimane\n\nAd esempio: 24 settimane, semestre, 3 mesi, anno intero.";
      return res.json({ type: "ok", reply });
    }

    if (!wizard.goal) {
      const reply =
        lang === "en"
          ? "Last step: what is your main goal for this period abroad? 🎯\n\nYou can answer freely, or get inspiration from these examples:\n• Improve English for university or work\n• Have a cultural experience and personal growth\n• Prepare exams such as IELTS or TOEFL\n• Understand if you might move to that country in the future\n\nWrite in one sentence what you expect from this trip."
          : "Ultimo passo: qual è il tuo obiettivo principale per questo periodo all’estero? 🎯\n\nPuoi scrivere in modo libero, oppure ispirarti a questi esempi:\n• Migliorare l’inglese per università o lavoro\n• Fare un’esperienza culturale e di crescita personale\n• Preparare esami come IELTS o TOEFL\n• Capire se in futuro potrei trasferirmi in quel Paese\n\nScrivi in una frase cosa ti aspetti dal viaggio.";
      return res.json({ type: "ok", reply });
    }

    // abbiamo budget + countryCode + weeks + goal
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
          result.push(lang === "en" ? "[Within budget]" : "[Budget ok]");
        } else {
          result.push(lang === "en" ? "[Over budget]" : "[Sopra budget]");
        }

        const cityLower = (p.city || "").toLowerCase();
        if (cityLower.includes("boston") || cityLower.includes("new york")) {
          result.push(
            lang === "en" ? "[Academic focus]" : "[Focus accademico]"
          );
        }
        if (
          cityLower.includes("los angeles") ||
          cityLower.includes("san diego") ||
          cityLower.includes("vancouver")
        ) {
          result.push(
            lang === "en" ? "[Lifestyle & outdoor]" : "[Lifestyle e outdoor]"
          );
        }
        if (cityLower.includes("toronto")) {
          result.push(
            lang === "en" ? "[Big city]" : "[Grande città]"
          );
        }

        if (score >= 4.5) {
          result.push(
            lang === "en" ? "[Very high match]" : "[Match molto alto]"
          );
        } else if (score >= 4.0) {
          result.push(lang === "en" ? "[Good match]" : "[Buon match]");
        } else if (score >= 3.5) {
          result.push(
            lang === "en" ? "[Budget compromise]" : "[Compromesso budget]"
          );
        } else {
          result.push(
            lang === "en" ? "[Use as reference]" : "[Usa come riferimento]"
          );
        }

        return result;
      }

      const cards = programs.slice(0, 3).map((p, index) => {
        const score = matchScore(p.total, wizard.budget);
        const tags = badgeArray(p, score);

        const lines =
          lang === "en"
            ? [
                `${flag}  OPTION ${index + 1}`,
                "",
                `Match: ${stars(score)}  (${score.toFixed(1)}/5)`,
                `${bar(score)}`,
                "",
                `School: ${p.name}`,
                `City: ${p.city}`,
                `Estimated duration: ${wizard.weeks} weeks`,
                "",
                `Total estimated cost: €${Math.round(p.total)}`,
                `  • Tuition: €${Math.round(p.tuition)}`,
                `  • Accommodation: €${Math.round(p.housing)}`,
                `  • Fees and other costs: €${Math.round(p.fees)}`,
                "",
                `Tags: ${tags.join("  ")}`,
                "",
                `Note: ${p.notes}`,
                "",
                "────────────────────────────────────────"
              ]
            : [
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

      const header =
        lang === "en"
          ? `Based on your goal "${wizard.goal.trim()}", your budget of about €${wizard.budget} and a duration of ${wizard.weeks} weeks in ${countryLabel}, here are the main options Edovia has found for you:\n\n`
          : `In base al tuo obiettivo "${wizard.goal.trim()}", al budget di circa €${wizard.budget} e alla durata di ${wizard.weeks} settimane in ${countryLabel}, ecco le principali opzioni che Edovia ha trovato per te:\n\n`;

      const cta =
        lang === "en"
          ? "To see full details, save this comparison and proceed with the application, [[CREA_UN_ACCOUNT]]."
          : "Per vedere i dettagli completi, salvare la comparazione e procedere con l'application, [[CREA_UN_ACCOUNT]].";

      const reply =
        header +
        "────────────────────────────────────────\n\n" +
        cards.join("\n\n") +
        "\n\n👉 " +
        cta;

      // reset wizard per eventuale nuova ricerca
      session.wizard = {};

      return res.json({
        type: "ok",
        reply
      });
    }

    // nessun partner compatibile
    const fallbackReply =
      lang === "en"
        ? "With the parameters you entered I cannot find compatible partners in the selected country. We can try to:\n• Increase the budget a bit\n• Reduce the duration\n• Consider another country (for example, Canada instead of USA)\n\nTell me what you prefer to change and we will run the comparison again."
        : "Per i parametri che hai inserito non trovo partner compatibili nei Paesi selezionati. Possiamo provare a:\n• Aumentare un po’ il budget\n• Ridurre la durata\n• Valutare un altro Paese (ad esempio Canada invece di USA)\n\nDimmi cosa preferisci modificare e rifacciamo il confronto.";
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

