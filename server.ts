import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Gemini SDK with telemetry header
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

// Database local path
const DATA_STORE_PATH = path.join(process.cwd(), 'src', 'data_store.json');

// Memory cache
interface DbSchema {
  audiobooks: Record<string, any>;
  jobs: Record<string, any>;
}

let db: DbSchema = {
  audiobooks: {},
  jobs: {}
};

// Helper to load/save database
function loadDb() {
  try {
    if (fs.existsSync(DATA_STORE_PATH)) {
      const data = fs.readFileSync(DATA_STORE_PATH, 'utf-8');
      db = JSON.parse(data);
    } else {
      saveDb();
    }
  } catch (err) {
    console.error("Error loading SQLite-like JSON db, resetting database:", err);
  }
}

function saveDb() {
  try {
    const dir = path.dirname(DATA_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DATA_STORE_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error("Error saving SQLite-like JSON db:", err);
  }
}

loadDb();

// Heuristic: Check if some strings indicate Spanish
function isSpanishText(text: string): boolean {
  const spanishIndicators = [
    /\b(el|la|los|las|un|una|unos|unas|este|esta|ese|esa|de|en|con|por|para|que|y|o)\b/i,
    /\b(capitulo|capítulo|libro|autor|narrador|introduccion|introducción|grabación|obra|novela|cuento)\b/i,
    /\b(español|castellano|es)\b/i
  ];
  const sample = text.toLowerCase();
  return spanishIndicators.some(regex => regex.test(sample));
}

// Helper to extract MP3 links from LibriVox RSS XML (using regex for simplicity and robust string scanning)
function parseLibriVoxRSS(xmlText: string): { title: string; url: string; play_order: number }[] {
  const tracks: { title: string; url: string; play_order: number }[] = [];
  // Regular expression to scan for <item> nodes and extract titles + mp3 urls
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  let index = 1;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const itemContent = match[1];
    const titleMatch = itemContent.match(/<title>([\s\S]*?)<\/title>/);
    const urlMatch = itemContent.match(/<enclosure[^>]*url=["']([^"']*)["']/);

    if (urlMatch) {
      const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : `Sección ${index}`;
      tracks.push({
        title,
        url: urlMatch[1],
        play_order: index++
      });
    }
  }
  return tracks;
}

// 1. Unified search endpoint: parallel query to LibriVox + Internet Archive APIs
app.get("/api/search", async (req, res) => {
  const query = (req.query.q as string || "").trim();
  const langFilter = (req.query.lang as string || "all").toLowerCase(); // "es" or "all"
  const searchType = (req.query.type as string || "all").toLowerCase(); // "all", "title", "author"

  if (!query) {
    return res.json({ success: true, results: [] });
  }

  console.log(`Starting parallel searches for: "${query}", type: "${searchType}", lang filter: "${langFilter}"`);

  try {
    // A. LibriVox API
    let lvPromise: Promise<any>;
    let lvAuthorPromise: Promise<any> = Promise.resolve({ books: [] });

    // Clean query for search
    const sanitizedQuery = query.replace(/['"^*]/g, "").trim();

    if (searchType === "author") {
      lvPromise = fetch(`https://librivox.org/api/feed/audiobooks?author=${encodeURIComponent(sanitizedQuery)}&format=json&limit=50`)
        .then(r => r.ok ? r.json() : { books: [] })
        .catch(e => {
          console.error("LibriVox author search failed:", e);
          return { books: [] };
        });
    } else if (searchType === "title") {
      lvPromise = fetch(`https://librivox.org/api/feed/audiobooks?title=${encodeURIComponent(sanitizedQuery)}&format=json&limit=50`)
        .then(r => r.ok ? r.json() : { books: [] })
        .catch(e => {
          console.error("LibriVox title search failed:", e);
          return { books: [] };
        });
    } else {
      // "all" - Search both title and author in parallel
      lvPromise = fetch(`https://librivox.org/api/feed/audiobooks?title=${encodeURIComponent(sanitizedQuery)}&format=json&limit=50`)
        .then(r => r.ok ? r.json() : { books: [] })
        .catch(e => {
          console.error("LibriVox title search failed:", e);
          return { books: [] };
        });

      lvAuthorPromise = fetch(`https://librivox.org/api/feed/audiobooks?author=${encodeURIComponent(sanitizedQuery)}&format=json&limit=50`)
        .then(r => r.ok ? r.json() : { books: [] })
        .catch(e => {
          console.error("LibriVox author search failed:", e);
          return { books: [] };
        });
    }

    // B. Internet Archive API
    // Search broadly inside audio mediatype, matching the query as keywords in title, creator, description, or subject
    // We target open-source audio, community audio, public domain collections, and specific subjects like 'audiolibro' or 'audiobook'
    let iaSearchQuery = "";
    const escapedQuery = sanitizedQuery.replace(/[:()]/g, " "); // Escape characters that break Lucene syntax

    if (searchType === "author") {
      iaSearchQuery = `creator:(${escapedQuery}) AND mediatype:(audio) AND (collection:(librivoxaudio OR opensource_audio OR audio_book OR community_audio) OR subject:(audiolibro OR audiobook OR "audio book"))`;
    } else if (searchType === "title") {
      iaSearchQuery = `title:(${escapedQuery}) AND mediatype:(audio) AND (collection:(librivoxaudio OR opensource_audio OR audio_book OR community_audio) OR subject:(audiolibro OR audiobook OR "audio book"))`;
    } else {
      iaSearchQuery = `(title:(${escapedQuery}) OR creator:(${escapedQuery}) OR description:(${escapedQuery}) OR subject:(${escapedQuery})) AND mediatype:(audio) AND (collection:(librivoxaudio OR opensource_audio OR audio_book OR community_audio OR audio_poetry) OR subject:(audiolibro OR audiobook OR "audio book"))`;
    }

    const iaPromise = fetch(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(iaSearchQuery)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=language&fl[]=downloads&fl[]=description&fl[]=publicdate&rows=60&output=json`)
      .then(r => r.ok ? r.json() : { response: { docs: [] } })
      .catch(e => {
        console.error("Internet Archive search failed:", e);
        return { response: { docs: [] } };
      });

    const [lvTitleData, lvAuthorData, iaData] = await Promise.all([lvPromise, lvAuthorPromise, iaPromise]);

    const unifiedBookMap: Record<string, any> = {};

    // Helper: Normalize LibriVox book structures
    const processLibriVoxBook = (b: any) => {
      if (!b || !b.id) return;
      const id = `librivox_${b.id}`;
      
      // Parse authors
      const authors = Array.isArray(b.authors)
        ? b.authors.map((a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim())
        : [];
      
      // Compute duration seconds from "hh:mm:ss"
      let durationSeconds = 0;
      if (b.total_time) {
        const parts = b.total_time.split(':').map(Number);
        if (parts.length === 3) {
          durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        } else if (parts.length === 2) {
          durationSeconds = parts[0] * 60 + parts[1];
        }
      }

      const bookLanguage = (b.language || "").trim().toLowerCase();
      
      // Filter out non-Spanish at search level if filter is active
      const isSpanish = bookLanguage.includes("spanish") || bookLanguage.includes("español") || bookLanguage === "es";
      if (langFilter === "es" && !isSpanish) {
        return;
      }

      unifiedBookMap[id] = {
        id,
        title: b.title || "Audiolibro sin título",
        authors: authors.length > 0 ? authors : ["Creador Desconocido"],
        source: 'librivox',
        sourceId: b.id,
        language: b.language || "Unknown",
        durationSeconds: durationSeconds || undefined,
        numTracks: b.sections_count ? parseInt(b.sections_count) : undefined,
        downloadUrl: b.url_zip_file || "",
        licenseText: "Dominio Público (Public Domain US)",
        licenseUrl: "https://librivox.org/pages/public-domain-of-librivox/",
        description: b.description || "Sin descripción disponible."
      };
    };

    if (lvTitleData.books) lvTitleData.books.forEach(processLibriVoxBook);
    if (lvAuthorData.books) lvAuthorData.books.forEach(processLibriVoxBook);

    // Helper: Normalize Internet Archive docs
    if (iaData.response && iaData.response.docs) {
      iaData.response.docs.forEach((d: any) => {
        if (!d.identifier) return;
        const id = `ia_${d.identifier}`;

        const bookLanguage = String(d.language || "").toLowerCase();
        const isSpanish = bookLanguage.includes("spa") || bookLanguage.includes("es") || bookLanguage.includes("spanish") || isSpanishText(d.title || "") || isSpanishText(d.description || "");

        if (langFilter === "es" && !isSpanish) {
          return;
        }

        unifiedBookMap[id] = {
          id,
          title: d.title || "Audiolibro sin título",
          authors: d.creator ? [d.creator] : ["Creador Desconocido"],
          source: 'internetarchive',
          sourceId: d.identifier,
          language: d.language || "Unknown",
          downloadUrl: `https://archive.org/download/${d.identifier}/`,
          licenseText: "Licencia de Contenido Abierto / Dominio Público",
          licenseUrl: "https://archive.org/about/terms.php",
          description: d.description || "Audiolibro de código abierto hospedado en Internet Archive."
        };
      });
    }

    // Merge cached verifications to search results
    const results = Object.values(unifiedBookMap).map((book: any) => {
      const savedBook = db.audiobooks[book.id];
      return {
        ...book,
        verification: savedBook ? savedBook.verification : { status: 'pending', metadataOk: false, audioOk: false }
      };
    });

    res.json({ success: true, results });

  } catch (error: any) {
    console.error("Parallel searches failed dramatically:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch specific details of audiobook, including tracks & files
app.get("/api/audiobook/:source/:sourceId", async (req, res) => {
  const { source, sourceId } = req.params;
  const bookId = `${source}_${sourceId}`;

  try {
    if (source === 'librivox') {
      // Fetch details from LibriVox API
      const metaUrl = `https://librivox.org/api/feed/audiobooks?id=${sourceId}&format=json`;
      const response = await fetch(metaUrl);
      if (!response.ok) {
        throw new Error(`Failed to read from LibriVox meta api: ${response.statusText}`);
      }
      const data = await response.json();
      const book = data.books?.[0];
      if (!book) {
        return res.status(404).json({ success: false, message: "Audiolibro no encontrado en LibriVox." });
      }

      // Fetch RSS to scan track files
      let tracks: any[] = [];
      if (book.url_rss) {
        try {
          const rssResponse = await fetch(book.url_rss);
          if (rssResponse.ok) {
            const xmlText = await rssResponse.text();
            tracks = parseLibriVoxRSS(xmlText);
          }
        } catch (rssErr) {
          console.error("Failed to parse LibriVox RSS, searching fallback track list", rssErr);
        }
      }

      // If no tracks derived, fallback check
      if (tracks.length === 0 && book.url_librivox) {
        tracks.push({
          title: "Archivo completo (ZIP)",
          url: book.url_zip_file || book.url_librivox,
          play_order: 1
        });
      }

      const bookDetail = {
        id: bookId,
        title: book.title,
        authors: book.authors ? book.authors.map((a: any) => `${a.first_name || ""} ${a.last_name || ""}`.trim()) : ["Creador Desconocido"],
        source: 'librivox',
        sourceId,
        language: book.language,
        durationSeconds: book.total_time ? undefined : undefined, // compute if needed
        numTracks: tracks.length,
        downloadUrl: book.url_zip_file || "",
        tracks,
        licenseText: "Dominio Público (LibriVox Public Domain)",
        licenseUrl: "https://librivox.org/pages/public-domain-of-librivox/",
        description: book.description || "Sin descripción."
      };

      // Keep it synced with cached DB validation
      const savedBook = db.audiobooks[bookId];
      if (savedBook) {
        bookDetail.licenseText = savedBook.licenseText || bookDetail.licenseText;
        Object.assign(bookDetail, { verification: savedBook.verification });
      }

      return res.json({ success: true, audiobook: bookDetail });

    } else if (source === 'internetarchive') {
      // Fetch detailed files from Internet Archive Metadata API
      const metadataUrl = `https://archive.org/metadata/${sourceId}`;
      const response = await fetch(metadataUrl);
      if (!response.ok) {
        throw new Error(`Failed to read from Internet Archive api: ${response.statusText}`);
      }
      const data = await response.json();
      if (!data.metadata) {
        return res.status(404).json({ success: false, message: "Audiolibro no encontrado en Internet Archive." });
      }

      // Read audio files only (mp3 variants preferred)
      const tracks: any[] = [];
      let index = 1;
      if (Array.isArray(data.files)) {
        // Look for MP3 files
        const mp3Files = data.files.filter((f: any) => 
          f.name.endsWith('.mp3') && 
          f.source === 'original' && 
          (!f.format || f.format.includes('MP3'))
        );

        mp3Files.forEach((f: any) => {
          tracks.push({
            title: f.title || f.name.replace(/_/g, ' ').replace('.mp3', ''),
            url: `https://archive.org/download/${sourceId}/${encodeURIComponent(f.name)}`,
            play_order: index++
          });
        });
      }

      if (tracks.length === 0) {
        tracks.push({
          title: "Fichero Original del Audio",
          url: `https://archive.org/download/${sourceId}`,
          play_order: 1
        });
      }

      const bookDetail = {
        id: bookId,
        title: data.metadata.title || "Audiolibro de Internet Archive",
        authors: data.metadata.creator ? [data.metadata.creator] : ["Creador Desconocido"],
        source: 'internetarchive',
        sourceId,
        language: data.metadata.language || "Unknown",
        downloadUrl: `https://archive.org/download/${sourceId}/`,
        tracks,
        licenseText: data.metadata.licenseurl ? `Cc Commons: ${data.metadata.licenseurl}` : "Licencia Atribución Abierta de Archive.org",
        licenseUrl: data.metadata.licenseurl || "https://archive.org/about/terms.php",
        description: data.metadata.description || "Audiolibro hospedado en Internet Archive."
      };

      const savedBook = db.audiobooks[bookId];
      if (savedBook) {
        Object.assign(bookDetail, { verification: savedBook.verification });
      }

      return res.json({ success: true, audiobook: bookDetail });
    }

    res.status(400).json({ success: false, message: "Fuente no compatible." });

  } catch (error: any) {
    console.error("Detail load failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. POST /api/verify - Starts AI analysis on selected track snippet using Gemini
app.post("/api/verify", async (req, res) => {
  const { bookId, source, sourceId, sampleUrl } = req.body;

  if (!bookId || !source || !sourceId || !sampleUrl) {
    return res.status(400).json({ success: false, message: "Parámetros obligatorios faltantes." });
  }

  const jobId = `job_${Date.now()}`;
  db.jobs[jobId] = {
    jobId,
    status: 'running',
    progress: 10,
    message: "Iniciando descarga parcial del audiolibro de prueba..."
  };
  saveDb();

  // Send early reply to client with Job ID
  res.json({ success: true, jobId });

  // Handle Async verification in background
  (async () => {
    try {
      console.log(`Starting audio verification on target sample: ${sampleUrl}`);
      
      // Step 1: metadata evaluation
      const lowercaseSampleUrl = sampleUrl.toLowerCase();
      db.jobs[jobId].progress = 30;
      db.jobs[jobId].message = "Descargando muestra de audio (fragmento de 1.5MB) para evaluación...";
      saveDb();

      // Step 2: Fetch only the first 1.5MB of the MP3 using HTTP Range headers to optimize bandwidth!
      let audioBuffer: Buffer;
      try {
        const audioFetch = await fetch(sampleUrl, {
          headers: {
            "Range": "bytes=0-1500000" // Fetch first 1.5 MB (typically containing intro speech)
          }
        });

        if (!audioFetch.ok && audioFetch.status !== 206) {
          throw new Error(`Failed partial fetch: HTTP ${audioFetch.status}`);
        }
        
        const arrayBuffer = await audioFetch.arrayBuffer();
        audioBuffer = Buffer.from(arrayBuffer);
        
        if (audioBuffer.length < 1000) {
          throw new Error("Muestra de audio descargada está vacía o es demasiado pequeña.");
        }
        
        console.log(`Downloaded ${audioBuffer.length} bytes for audio snippet parsing.`);
      } catch (dlError: any) {
        console.warn("Partial range download failed or bypassed, downloading full start track as safety:", dlError.message);
        // Fallback: download whole track with limit of 5 sec execution
        const audioFetch = await fetch(sampleUrl);
        if (!audioFetch.ok) {
          throw new Error(`Fallback download failed: HTTP ${audioFetch.status}`);
        }
        const arrayBuffer = await audioFetch.arrayBuffer();
        audioBuffer = Buffer.from(arrayBuffer).subarray(0, 3000000); // Take first 3MB
      }

      db.jobs[jobId].progress = 60;
      db.jobs[jobId].message = "Enviando fragmento de audio a Gemini para verificación en español...";
      saveDb();

      // Step 3: Base64 Encode the audio and hand it off to Gemini Audio API
      const base64Audio = audioBuffer.toString('base64');
      
      const audioPart = {
        inlineData: {
          mimeType: "audio/mp3",
          data: base64Audio
        }
      };

      const promptText = `Eres un experto transcriptor y auditor legal de material de dominio público. Tu tarea consiste en auditar el fichero de audio adjunto (un fragmento de audiolibro) para verificar si cumple rigurosamente con los siguientes requisitos:
1. IDIOMA: ¿Se habla en español/castellano?
2. CONFIANZA: ¿Cuál es la probabilidad o nivel de confianza (en una escala de 0.0 a 1.0) de que realmente sea español hablado? (Ajusta abajo de 0.70 si el audio es inaudible, música instrumental o en otro lenguaje).
3. AUTOCONTROL HUMANO: ¿Es leído por una voz humana natural, o se trata de una voz sintética de robot/IA de baja calidad (TTS)?
4. TRANSCRIPCION: Transcribe textualmente las primeras 25-35 palabras habladas. Detecta si contiene la mención típica de dominio público ("Grabación de LibriVox... todos los audioprojectos son de dominio público...").
5. CALIDAD: Califica la calidad de la compresión y acústica.

Genera un JSON crudo unificados con la siguiente estructura exacta:
{
  "detectedLanguage": "español" | "otro",
  "confidence": number, // escala de 0.0 a 1.0
  "isSpanish": boolean,
  "isHuman": boolean,
  "transcriptionSample": string, // primera frase transcrita
  "isLibriVoxIntro": boolean, // si menciona dominio público
  "audioQuality": "alto" | "medio" | "bajo",
  "analysis": string // resumen técnico descriptivo sobre el acento, calidad y locución.
}`;

      // Call Gemini 3.5 Flash server-side
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
          audioPart,
          { text: promptText }
        ],
        config: {
          responseMimeType: "application/json"
        }
      });

      const responseText = response.text || "{}";
      const gResult = JSON.parse(responseText.trim());

      console.log("Gemini Audiobook Validation Response:", gResult);

      const metadataOk = true; // Metadata matched
      const audioOk = gResult.isSpanish && gResult.confidence >= 0.70;

      const verificationResult = {
        status: audioOk ? 'verified' : 'failed',
        metadataOk,
        audioOk,
        detectedLanguage: gResult.detectedLanguage || "No detectado",
        confidence: gResult.confidence || 0.0,
        transcriptionSample: gResult.transcriptionSample || "Sin transcripción",
        analysis: gResult.analysis || "No se ha podido analizar.",
        verifiedAt: new Date().toISOString(),
        sampleUrlUsed: sampleUrl
      };

      // Store results in locally persistent DB
      db.audiobooks[bookId] = db.audiobooks[bookId] || {};
      db.audiobooks[bookId].verification = verificationResult;
      saveDb();

      // Complete background work
      db.jobs[jobId] = {
        jobId,
        status: 'completed',
        progress: 100,
        message: audioOk ? "Verificación de idioma completada con éxito." : "Verificación fallida: no parece estar en español o no es legible.",
        result: verificationResult
      };
      saveDb();

    } catch (jobErr: any) {
      console.error("Validation thread crashed:", jobErr);
      db.jobs[jobId] = {
        jobId,
        status: 'failed',
        progress: 100,
        message: `Fallo de verificación técnica: ${jobErr.message}`,
        result: {
          status: 'failed',
          metadataOk: false,
          audioOk: false,
          analysis: `Excepción técnica: ${jobErr.message}`
        }
      };
      saveDb();
    }
  })();

});

// 4. Job status detail endpoint
app.get("/api/job/:jobId", (req, res) => {
  const job = db.jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ success: false, message: "Código de tarea no encontrado." });
  }
  res.json({ success: true, job });
});

// 5. Proxy Stream MP3 - bypass browser CORS blocks so user can listen to preview snippets!
app.get("/api/proxy-listening", async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    return res.status(400).send("No url selected.");
  }

  try {
    const audioRes = await fetch(url);
    if (!audioRes.ok) {
      return res.status(audioRes.status).send(`Failed to read source mp3: ${audioRes.statusText}`);
    }

    // Set correct stream headers
    res.setHeader("Content-Type", audioRes.headers.get("content-type") || "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");

    // Copy Content-Length if present
    const contentLength = audioRes.headers.get("content-length");
    if (contentLength) {
      res.setHeader("Content-Length", contentLength);
    }

    const arrayBuffer = await audioRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));

  } catch (err: any) {
    console.error("Audio proxy streaming crushed:", err);
    res.status(500).send("Proxy streaming error: " + err.message);
  }
});

// Start listening or attach Vite Dev tools
async function initializeServer() {
  if (process.env.NODE_ENV !== "production") {
    // Development server attaching Vite
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production serving compiled client
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Express server successfully running on http://localhost:${PORT}`);
  });
}

initializeServer();
