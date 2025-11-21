import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 3001;

// Configura OpenAI: la chiave la metteremo come variabile d'ambiente
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.use(cors());
app.use(express.json());

// memoria in RAM per conteggio messaggi per sessione (ok per demo)
const sessions = new Map();
const MAX_MESSAGES_FREE = 20;

app.post("/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: "sessionId e message sono obbligatori" });
    }

    // conteggio messaggi per sessionId
    const current = sessions.get(sessionId) || 0;
    if (current >= MAX_MESSAGES_FREE) {
      return res.json({
        type: "limit_reached",
        reply:
          "Hai usato tutte le domande gratuite per esplorare i programmi. " +
          "Per salvare questa comparazione e continuare senza limiti, crea il tuo account Edovia.",
        ctaUrl: "https://app.edovia.ai/signup" // cambierai questo quando hai la vera app
      });
    }
    sessions.set(sessionId, current + 1);

    // chiamata al modello OpenAI
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Sei Edovia AI, un comparatore di programmi di studio e formazione all'estero. " +
            "Rispondi in modo breve, concreto, e guida l'utente a confrontare programmi, costi e requisiti. " +
            "Non inventare prezzi se non sei sicuro: parla di fasce di budget e opzioni."
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    const reply = completion.choices?.[0]?.message?.content ?? "C'è stato un problema, riprova tra poco.";

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

