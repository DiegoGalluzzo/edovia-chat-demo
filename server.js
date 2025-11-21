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

// sessione: { count, wizard: { budget, countryCode, weeks, goal, city } }
const sessions = new Map();
const MAX_MESSAGES_FREE = 20;

// lista dei Paesi disponibili in base ai file partners/*.json
const partnersDir = path.join(__dirname, "partners");
let availableCountries = [];
try {
  availableCountries = fs
    .readdirSync(partnersDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.basename(f, ".json"));
} catch (err) {
  console.error("Errore leggendo la cartella partners:", err.message);
}

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

/* ------------------- UTIL ------------------- */

function naturalJoin(list) {
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  const head = list.slice(0, -1).join(", ");
  return head + " e " + list[list.length - 1];
}

/* ------------------- LLM ORCHESTRATION ------------------- */

/**
 * Chiediamo al modello di:
 * - aggiornare lo stato wizard (budget, countryCode, weeks, goal, city)
 * - decidere l'azione: ask_more | ready_to_compare | off_topic
 * - generare la risposta naturale da mostrare all'utente (reply)
 *
 * Il tutto in JSON, forzato.
 */
async function runWizardControllerLLM({ wizard, message }) {
  const sysPrompt = `
Sei il cervello di "Edovia AI", un assistente che aiuta studenti e famiglie a confrontare programmi di studio all'estero.

NON stai parlando direttamente con l'utente: rispondi SEMPRE e SOLO in JSON.
Il backend userà il campo "reply" per mostrare il testo all'utente.

Regole:
- Lingua: SEMPRE italiano.
- Obiettivo: guidare l'utente a definire 4 elementi per la comparazione:
  1) budget totale (corso + alloggio), in euro
  2) Paese (usa, canada...) come countryCode tra quelli disponibili
  3) durata in settimane
  4) obiettivo del viaggio (goal), testo libero
  opzionale: città preferita (city), come testo libero
- Parti dallo stato "wizard" che ti viene passato (può avere già alcuni campi pieni).
- Aggiorna o aggiungi SOLO i campi che l'utente esplicita in modo chiaro nel nuovo messaggio.
- Se l'utente cambia idea su budget/destinazione/durata/goal, puoi sovrascrivere il valore precedente.

Paesi disponibili per la comparazione:
${availableCountries.join(", ") || "(nessuno – ma di solito us, canada)"}

Comportamento:
- "action": 
  - "ask_more" → manca ancora almeno uno tra budget, countryCode, weeks, goal.
  - "ready_to_compare" → hai TUTTI: budget, countryCode, weeks, goal (city è opzionale).
  - "off_topic" → il messaggio è soprattutto fuori tema (es. ricette, videogiochi, politica).
- "reply":
  - se ask_more:
    - spiega in modo breve cosa hai capito finora (budget/destinazione/durata/goal/città).
    - chiedi in modo naturale SOLO le informazioni che mancano, una o due alla volta.
    - tono amichevole, concreto, da consulente, non da chatbot.
  - se ready_to_compare:
    - riassumi rapidamente i parametri (budget, durata, Paese, eventuale città, goal).
    - NON inventare scuole, città o prezzi.
    - di' che ora mostrerai le opzioni migliori tra le scuole partner Edovia.
  - se off_topic:
    - rispondi con una frase breve e gentile dicendo che Edovia AI si occupa solo di programmi di studio all'estero.
    - invita l'utente a dirti budget, Paese e durata.
- Se l'utente chiede destinazioni che non sono nei Paesi disponibili (es. Francia, Giappone, Luna, Marte):
  - se è una destinazione reale ma non supportata (Francia, Spagna...):
    - "action" = "ask_more"
    - spiega che al momento Edovia confronta solo i Paesi disponibili (es. USA e Canada)
    - proponi di lavorare su uno di quelli.
    - non impostare countryCode.
  - se dice cose impossibili tipo "sulla luna", "su Marte":
    - puoi ironizzare in modo leggero (1 frase), ma poi riportalo gentilmente su mete reali e supportate.
- Goal:
  - qualsiasi frase che esprima motivazioni, desideri, obiettivi personali o accademici va bene come goal.
  - non serve sia "pulita": può essere anche una frase lunga dell'utente.
- Budget:
  - interpreta numeri come importi in euro (es. 7000, 7k, 7.000).
  - se dice "non ho budget" o simile, non impostare il budget e chiedilo in modo morbido.
- Durata:
  - "un anno" ≈ 48 settimane, "un semestre" ≈ 24, "un'estate" ≈ 12.
  - se dice "6 mesi" ≈ 24 settimane.
- Paesi:
  - se dice "Stati Uniti", "America", "USA" → countryCode "us".
  - se dice "Canada" → countryCode "canada".
- Città:
  - se nomina una città (es. New York, San Diego, Toronto), copiala così come city (senza interpretare altro).
  - NON cambiare countryCode in base alla città se nel wizard c'è già un Paese coerente (usa o canada).
    Se il Paese non è ancora impostato e la città è ovviamente in uno dei Paesi disponibili, puoi impostare il Paese.

Struttura di output richiesta (obbligatoria):
{
  "updatedWizard": {
    "budget": number | null,
    "countryCode": string | null,
    "weeks": number | null,
    "goal": string | null,
    "city": string | null
  },
  "action": "ask_more" | "ready_to_compare" | "off_topic",
  "reply": "testo in italiano da mostrare all'utente"
}

Rispetta ESATTAMENTE questa struttura e usa SEMPRE JSON valido.
`;

  const userPayload = {
    wizard,
    message
  };

  const completion = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: sysPrompt
      },
      {
        role: "user",
        content: JSON.stringify(userPayload)
      }
    ]
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
  } catch (err) {
    console.error("Errore nel parsing JSON del controller LLM:", err.message);
    parsed = null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.updatedWizard ||
    !parsed.action
  ) {
    return {
      updatedWizard: wizard,
      action: "ask_more",
      reply:
        "C'è stato un piccolo problema tecnico nell'elaborazione. Riproviamo: dimmi budget totale, Paese e durata, così ti mostro i programmi compatibili."
    };
  }

  return parsed;
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
      session = { count: 0, wizard: {} };
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
    const wizard = session.wizard || (session.wizard = {});

    // 1) chiediamo al modello di aggiornare lo stato e decidere l'azione
    const control = await runWizardControllerLLM({ wizard, message: text });

    // aggiorna lo stato wizard con quanto restituito dal modello
    session.wizard = {
      ...wizard,
      ...(control.updatedWizard || {})
    };

    const updated = session.wizard;
    const action = control.action;
    const llmReply = control.reply || "";

    // 2) gestiamo le azioni

    // off-topic: mostriamo solo il reply del modello
    if (action === "off_topic") {
      return res.json({
        type: "ok",
        reply: llmReply
      });
    }

    // ask_more: ancora dati mancanti, mostriamo solo il reply del modello
    if (action === "ask_more") {
      return res.json({
        type: "ok",
        reply: llmReply
      });
    }

    // ready_to_compare: abbiamo tutti i dati per la comparazione
    if (action === "ready_to_compare") {
      const { budget, countryCode, weeks, goal, city } = updated;

      if (!budget || !countryCode || !weeks || !goal) {
        // in teoria non dovrebbe succedere, ma mettiamo una guardia
        const fallbackReply =
          "Ho quasi tutte le informazioni, ma me ne manca ancora qualcuna tra budget, Paese, durata e obiettivo. Dimmi in una frase chiara: budget totale, Paese (es. USA/Canada) e per quanto tempo vorresti restare.";
        return res.json({ type: "ok", reply: fallbackReply });
      }

      const programs = comparePrograms({
        countryCode,
        budget,
        weeks
      });

      const countryLabel = countryCode === "us" ? "USA" : countryCode;
      const flag =
        countryCode === "us"
          ? "🇺🇸"
          : countryCode === "canada"
          ? "🇨🇦"
          : "🌍";

      if (!programs.length) {
        const noProgReply =
          llmReply +
          "\n\n" +
          "Per la combinazione che hai indicato non trovo programmi compatibili tra i partner disponibili. Possiamo provare a:\n" +
          "• Aumentare un po’ il budget\n" +
          "• Ridurre la durata\n" +
          "• Oppure considerare un altro Paese tra quelli disponibili\n\n" +
          "Dimmi tu cosa preferisci cambiare e rifacciamo il confronto.";
        // non resetto il wizard, così l'utente può correggere un solo parametro
        return res.json({ type: "ok", reply: noProgReply });
      }

      // helper per punteggio match
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

      // verifica se abbiamo partner esattamente nella città richiesta
      let cityNote = "";
      if (city) {
        const requestedCityLower = city.toLowerCase();
        const partnersForCountry = loadPartners(countryCode);
        const hasExactCity = partnersForCountry.some(
          (p) => (p.city || "").toLowerCase() === requestedCityLower
        );
        if (!hasExactCity) {
          cityNote =
            `Nota: al momento non abbiamo partner diretti a ${city}, ` +
            `quindi ti mostro le opzioni più vicine per esperienza e qualità in ${countryLabel}.\n\n`;
        }
      }

      const cards = programs.slice(0, 3).map((p, index) => {
        const score = matchScore(p.total, budget);
        const tags = badgeArray(p, score);

        const lines = [
          `${flag}  OPZIONE ${index + 1}`,
          "",
          `Match: ${stars(score)}  (${score.toFixed(1)}/5)`,
          `${bar(score)}`,
          "",
          `Scuola: ${p.name}`,
          `Città: ${p.city}`,
          `Durata stimata: ${weeks} settimane`,
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
        llmReply.trim() +
        "\n\n" +
        cityNote +
        "Ecco alcune opzioni da cui partire:\n\n" +
        "────────────────────────────────────────\n\n";

      const cta =
        "Per vedere i dettagli completi, salvare la comparazione e procedere con l'application, crea il tuo account Edovia [[CREA_UN_ACCOUNT]]";

      const reply = header + cards.join("\n\n") + "\n\n" + cta;

      // reset wizard per eventuale nuova ricerca
      session.wizard = {};

      return res.json({
        type: "ok",
        reply
      });
    }

    // fallback di sicurezza
    const fallbackReply =
      "Ho bisogno di qualche informazione in più per aiutarti bene. Dimmi in una frase: budget indicativo, Paese (es. USA/Canada) e per quanto tempo vorresti restare.";
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

