import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, BookOpen, CheckCircle, AlertCircle, Loader2, Play, Pause, 
  Download, ExternalLink, ShieldCheck, Volume2, RefreshCw, Globe, 
  FileAudio, FileText, ChevronRight, Heart, Info, Sparkles
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Audiobook, Track, VerificationResult, JobState } from './types';

export default function App() {
  // Search inputs
  const [query, setQuery] = useState('Don Quijote');
  const [onlySpanish, setOnlySpanish] = useState(true);
  const [searchType, setSearchType] = useState<'all' | 'title' | 'author'>('all');
  const [searching, setSearching] = useState(false);
  const [books, setBooks] = useState<Audiobook[]>([]);

  // Selected item detail and tracks
  const [selectedBook, setSelectedBook] = useState<Audiobook | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [chapters, setChapters] = useState<Track[]>([]);

  // Active verified state for the currently displayed book
  const [manualVerification, setManualVerification] = useState<VerificationResult | null>(null);

  // Active background jobs of ASR/Gemini check
  const [currentJob, setCurrentJob] = useState<JobState | null>(null);
  const [jobIntervalId, setJobIntervalId] = useState<NodeJS.Timeout | null>(null);

  // Embedded Player state
  const [activeTrack, setActiveTrack] = useState<{ bookId: string; trackUrl: string; title: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Saved bookmark shelf
  const [bookmarks, setBookmarks] = useState<string[]>([]);

  // Notification bubble
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  const showNotice = (text: string, type: 'success' | 'error' | 'info' = 'info') => {
    setNotice({ text, type });
    setTimeout(() => {
      setNotice(null);
    }, 4500);
  };

  // Sync stateful playback rate with actual HTML5 media element
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackSpeed;
    }
  }, [playbackSpeed, activeTrack]);

  // Perform core queries
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setSearching(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&lang=${onlySpanish ? 'es' : 'all'}&type=${searchType}`);
      const data = await response.json();
      if (data.success) {
        setBooks(data.results || []);
        showNotice(`Se encontraron ${data.results?.length || 0} audiolibros coincidentes.`, 'success');
      } else {
        showNotice(data.error || 'Ocurrió un error en el servidor.', 'error');
      }
    } catch (err) {
      console.error(err);
      showNotice('Fallo de red al conectar al buscador backend.', 'error');
    } finally {
      setSearching(false);
    }
  };

  // Initial trigger
  useEffect(() => {
    handleSearch();
  }, []);

  // Poll for background verification task completion
  useEffect(() => {
    if (currentJob && currentJob.status === 'running') {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/job/${currentJob.jobId}`);
          const data = await res.json();
          if (data.success && data.job) {
            const updatedJob = data.job;
            setCurrentJob(updatedJob);

            if (updatedJob.status === 'completed' || updatedJob.status === 'failed') {
              if (jobIntervalId) clearInterval(jobIntervalId);
              setJobIntervalId(null);

              // Update primary book's verification state in lists & current detailed display
              const results = updatedJob.result as VerificationResult;
              if (selectedBook) {
                setManualVerification(results);
                // Also update item within books array list
                setBooks(prev => prev.map(bk => {
                  if (bk.id === selectedBook.id) {
                    return { ...bk, verification: results };
                  }
                  return bk;
                }));
              }
              showNotice(
                updatedJob.status === 'completed' && results.audioOk
                  ? '¡Audiolibro certificado con éxito en Español!'
                  : 'Fallo al verificar el audiolibro.', 
                updatedJob.status === 'completed' && results.audioOk ? 'success' : 'error'
              );
            }
          }
        } catch (err) {
          console.error("Job polling failure:", err);
        }
      }, 1500);

      setJobIntervalId(interval);
      return () => clearInterval(interval);
    }
  }, [currentJob?.jobId, currentJob?.status]);

  // Cleanup helper
  useEffect(() => {
    return () => {
      if (jobIntervalId) clearInterval(jobIntervalId);
    };
  }, [jobIntervalId]);

  // Load detailed single item containing chapters/tracks list
  const selectAudiobook = async (book: Audiobook) => {
    setLoadingDetail(true);
    setManualVerification(book.verification || null);
    setSelectedBook(book);
    setChapters([]);
    try {
      const response = await fetch(`/api/audiobook/${book.source}/${book.sourceId}`);
      const data = await response.json();
      if (data.success && data.audiobook) {
        setChapters(data.audiobook.tracks || []);
        if (data.audiobook.verification) {
          setManualVerification(data.audiobook.verification);
        }
      } else {
        showNotice('No se pudieron recuperar las pistas individuales.', 'error');
      }
    } catch (err) {
      console.error(err);
      showNotice('Error al conectar con la API de detalle.', 'error');
    } finally {
      setLoadingDetail(false);
    }
  };

  // Launch the AI analysis of the audio
  const startAIVerification = async () => {
    if (!selectedBook || chapters.length === 0) {
      showNotice('Se requieren capítulos válidos para iniciar la muestra.', 'error');
      return;
    }

    // Pick first track of the list as optimal language snippet
    const firstTrack = chapters[0];
    if (!firstTrack || !firstTrack.url) {
      showNotice('Falta enlace a pistas del primer capítulo.', 'error');
      return;
    }

    try {
      const response = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId: selectedBook.id,
          source: selectedBook.source,
          sourceId: selectedBook.sourceId,
          sampleUrl: firstTrack.url
        })
      });
      const data = await response.json();
      if (data.success && data.jobId) {
        setCurrentJob({
          jobId: data.jobId,
          status: 'running',
          progress: 5,
          message: 'Inicializando motor IA...'
        });
        showNotice('Tarea de audición iniciada. Analizando primer fragmento...', 'info');
      } else {
        showNotice('Error al arrancar tarea de audición.', 'error');
      }
    } catch (err) {
      console.error(err);
      showNotice('El servidor no respondió al comando de verificación.', 'error');
    }
  };

  // Handle embedded player controls with stream CORS proxying
  const selectTrackForPlayback = (track: Track) => {
    if (!selectedBook) return;
    
    // Pass raw URL into our Express server proxy so browser treats it local and ignores CORS block!
    const proxiedUrl = `/api/proxy-listening?url=${encodeURIComponent(track.url)}`;
    
    setPlayerLoading(true);
    setActiveTrack({
      bookId: selectedBook.id,
      trackUrl: proxiedUrl,
      title: track.title
    });
    setIsPlaying(false);

    if (audioRef.current) {
      audioRef.current.src = proxiedUrl;
      audioRef.current.load();
    }
  };

  const togglePrimaryPlayback = () => {
    if (!audioRef.current || !activeTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play()
        .then(() => setIsPlaying(true))
        .catch(e => {
          console.error("Audio playback error:", e);
          showNotice("Error al iniciar reproducción. Intente nuevamente.", "error");
        });
    }
  };

  // Monitor internal player audio events
  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleAudioLoaded = () => {
    setPlayerLoading(false);
    if (audioRef.current) {
      setDuration(audioRef.current.duration || 0);
      audioRef.current.play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
      setCurrentTime(val);
    }
  };

  const formatAudioTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Bookmark toggler
  const toggleBookmark = (id: string) => {
    if (bookmarks.includes(id)) {
      setBookmarks(prev => prev.filter(b => b !== id));
      showNotice("Eliminado de la estantería guardada.");
    } else {
      setBookmarks(prev => [...prev, id]);
      showNotice("Guardado en tu estantería personal.", "success");
    }
  };

  return (
    <div className="min-h-screen bg-[#0E1012] text-gray-200 antialiased font-sans pb-28">
      {/* Hidden browser audio module */}
      <audio 
        ref={audioRef} 
        onTimeUpdate={handleTimeUpdate} 
        onLoadedMetadata={handleAudioLoaded}
        onWaiting={() => setPlayerLoading(true)}
        onPlaying={() => setPlayerLoading(false)}
        onEnded={() => setIsPlaying(false)}
      />

      {/* Floating global notice message bubble */}
      <AnimatePresence>
        {notice && (
          <motion.div 
            initial={{ opacity: 0, y: -25, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -15, scale: 0.95 }}
            className={`fixed top-5 right-5 z-50 p-4 rounded-xl shadow-xl flex items-center space-x-3 max-w-sm backdrop-blur-md border ${
              notice.type === 'success' ? 'bg-emerald-950/75 border-emerald-500/30 text-emerald-300' :
              notice.type === 'error' ? 'bg-rose-950/75 border-rose-500/30 text-rose-300' :
              'bg-blue-950/75 border-blue-500/30 text-blue-300'
            }`}
          >
            {notice.type === 'success' ? <CheckCircle className="h-5 w-5 shrink-0" /> : <Info className="h-5 w-5 shrink-0" />}
            <span className="text-sm font-medium">{notice.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modern Slick Header */}
      <div className="border-b border-gray-800 bg-[#121518]/90 sticky top-0 z-40 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-3">
            <div className="relative p-2.5 bg-gradient-to-tr from-cyan-600 to-indigo-600 rounded-xl text-white shadow-xl shadow-cyan-950/20">
              <BookOpen className="h-6 w-6" id="app-logo-icon" />
              <div className="absolute -top-1 -right-1 h-3 w-3 bg-emerald-400 rounded-full border-2 border-[#121518] animate-pulse"></div>
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
                Audiobook Verifier MVP <span className="text-[10px] bg-cyan-950 text-cyan-400 px-2 py-0.5 rounded-full font-mono border border-cyan-800/30">v1.2</span>
              </h1>
              <p className="text-xs text-gray-400">Verificador automático por IA de audiolibros públicos en Español</p>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <span className="text-xs text-gray-400 hidden lg:inline">
              Estantería Guardada ({bookmarks.length})
            </span>
            <div className="flex -space-x-1">
              {books.slice(0, 3).map((b, i) => (
                <div key={b.id} className="h-7 w-7 rounded-full bg-slate-800 border-2 border-[#121518] text-[9px] font-bold flex items-center justify-center text-cyan-400 font-mono">
                  {b.source === 'librivox' ? 'LV' : 'IA'}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Main Container Layout */}
      <div className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Side: Search Panel & List results */}
        <div className="lg:col-span-7 space-y-6">
          
          {/* Slick Search Box */}
          <div className="bg-[#121518] border border-gray-800 rounded-2xl p-6 shadow-md relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
              <Globe className="h-24 w-24 text-white" />
            </div>

            <h2 className="text-sm font-semibold tracking-wider text-gray-300 uppercase mb-4 flex items-center gap-2">
              <Search className="h-4 w-4 text-cyan-400" /> Buscar Catálogo Público
            </h2>

            <form onSubmit={handleSearch} className="space-y-4">
              {/* Selector de modo de búsqueda (Todo/Título/Autor) */}
              <div className="flex bg-[#181C21] p-1 rounded-xl border border-gray-800 gap-1">
                <button
                  type="button"
                  onClick={() => setSearchType('all')}
                  className={`flex-1 text-center py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    searchType === 'all'
                      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white shadow font-bold'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800/40'
                  }`}
                >
                  Buscar Todo
                </button>
                <button
                  type="button"
                  onClick={() => setSearchType('title')}
                  className={`flex-1 text-center py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    searchType === 'title'
                      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white shadow font-bold'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800/40'
                  }`}
                >
                  Por Título
                </button>
                <button
                  type="button"
                  onClick={() => setSearchType('author')}
                  className={`flex-1 text-center py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                    searchType === 'author'
                      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white shadow font-bold'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800/40'
                  }`}
                >
                  Por Autor
                </button>
              </div>

              <div className="relative group">
                <input 
                  type="text" 
                  value={query} 
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    searchType === 'author'
                      ? "Nombre del autor (Ej. Cervantes, Bram Stoker, Mary Shelley, Espronceda...)"
                      : searchType === 'title'
                      ? "Título de la obra (Ej. Don Quijote, La Celestina, Drácula, Frankenstein...)"
                      : "Ej. Don Quijote, Cervantes, La Celestina, Drácula..."
                  }
                  className="w-full bg-[#181C21] border border-gray-700 rounded-xl px-4 py-3 pl-11 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 transition-all text-sm"
                />
                <Search className="absolute left-4 top-3.5 h-4 w-4 text-gray-500 group-focus-within:text-cyan-400 transition-colors" />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="flex items-center space-x-2.5 cursor-pointer select-none">
                  <div className="relative">
                    <input 
                      type="checkbox" 
                      checked={onlySpanish} 
                      onChange={(e) => setOnlySpanish(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-10 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[#121518] after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                  </div>
                  <span className="text-xs text-gray-300 font-medium">Restringir solo a idioma Español (Filtro Metadata)</span>
                </label>

                <button 
                  type="submit" 
                  disabled={searching}
                  className="bg-gradient-to-r from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 disabled:from-gray-800 disabled:to-gray-800 text-white font-medium text-xs px-5 py-3 rounded-xl shadow-lg transition-all flex items-center space-x-2 cursor-pointer"
                >
                  {searching ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Buscando...</span>
                    </>
                  ) : (
                    <>
                      <span>Consultar Fuentes</span>
                      <ChevronRight className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Results Grid List */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-md font-medium text-white flex items-center gap-2">
                Resultados Normalizados 
                <span className="bg-gray-800 text-gray-300 text-xs px-2.5 py-0.5 rounded-full font-semibold">
                  {books.length}
                </span>
              </h3>
              <p className="text-xs text-gray-400">LibriVox + Internet Archive combinados</p>
            </div>

            {searching ? (
              <div className="bg-[#121518]/40 border border-gray-800/80 rounded-2xl p-16 flex flex-col items-center justify-center text-center space-y-4">
                <Loader2 className="h-10 w-10 text-cyan-500 animate-spin" />
                <div className="space-y-1">
                  <p className="font-medium text-white text-sm">Consultando catálogos internacionales...</p>
                  <p className="text-xs text-gray-400">Paralelizando hilos de LibriVox y Archive.org API</p>
                </div>
              </div>
            ) : books.length === 0 ? (
              <div className="bg-[#121518]/40 border border-gray-800/80 rounded-2xl p-16 flex flex-col items-center justify-center text-center space-y-3">
                <Info className="h-8 w-8 text-gray-500" />
                <p className="font-medium text-white text-sm">No hay registros cargados</p>
                <p className="text-xs text-gray-400 max-w-sm mx-auto">Prueba buscando un autor o título clásico como "Cervantes", "Espronceda" o "Gabriel".</p>
              </div>
            ) : (
              <div className="space-y-3">
                {books.map((book) => {
                  const isVerified = book.verification?.status === 'verified' && book.verification?.audioOk;
                  const isFailed = book.verification?.status === 'failed';
                  const isBookmarked = bookmarks.includes(book.id);

                  return (
                    <motion.div 
                      key={book.id}
                      onClick={() => selectAudiobook(book)}
                      whileHover={{ scale: 1.01 }}
                      className={`group border rounded-xl p-4 transition-all cursor-pointer flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 ${
                        selectedBook?.id === book.id 
                          ? 'bg-[#182026] border-cyan-500/50 shadow-inner' 
                          : 'bg-[#121518] hover:bg-[#15191E] border-gray-800/80 hover:border-gray-700'
                      }`}
                    >
                      <div className="space-y-1.5 flex-1 min-w-0">
                        <div className="flex items-center flex-wrap gap-2">
                          <span className={`text-[9px] uppercase font-mono px-2 py-0.5 rounded-md font-semibold tracking-wide ${
                            book.source === 'librivox' 
                              ? 'bg-amber-950 text-amber-300 border border-amber-800/30' 
                              : 'bg-indigo-950 text-indigo-300 border border-indigo-800/30'
                          }`}>
                            {book.source === 'librivox' ? 'LibriVox' : 'Internet Archive'}
                          </span>

                          <span className="text-[10px] text-gray-400 flex items-center gap-1">
                            <Globe className="h-3 w-3" /> {book.language || 'Multi'}
                          </span>

                          {/* Instant verification badges synced from local DB state */}
                          {isVerified && (
                            <span className="text-[10px] bg-emerald-950 text-emerald-400 border border-emerald-800/50 px-2 py-0.5 rounded-full flex items-center gap-1 font-semibold">
                              <ShieldCheck className="h-3 w-3 text-emerald-400" /> Certificado Español
                            </span>
                          )}
                          {isFailed && (
                            <span className="text-[10px] bg-rose-950 text-rose-400 border border-rose-800/50 px-2 py-0.5 rounded-full flex items-center gap-1 font-semibold">
                              <AlertCircle className="h-3 w-3 text-rose-400" /> No válido
                            </span>
                          )}
                        </div>

                        <h4 className="font-semibold text-white text-sm sm:text-base group-hover:text-cyan-400 transition-colors truncate">
                          {book.title}
                        </h4>

                        <p className="text-xs text-gray-400 truncate">
                          por <span className="text-gray-300 font-medium">{book.authors.join(', ')}</span>
                        </p>
                      </div>

                      <div className="flex items-center space-x-3 shrink-0 self-end sm:self-center">
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleBookmark(book.id);
                          }}
                          className={`p-2 rounded-lg border transition-all hover:bg-gray-800 ${
                            isBookmarked 
                              ? 'border-rose-900 bg-rose-950/20 text-rose-400' 
                              : 'border-gray-800 text-gray-500 hover:text-white'
                          }`}
                        >
                          <Heart className={`h-4 w-4 ${isBookmarked ? 'fill-rose-400' : ''}`} />
                        </button>
                        <ChevronRight className="h-5 w-5 text-gray-600 group-hover:text-cyan-400 group-hover:translate-x-0.5 transition-all" />
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Selected Audiobook Sandbox details & Live Verification */}
        <div className="lg:col-span-5 space-y-6">
          
          {selectedBook ? (
            <motion.div 
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-[#121518] border border-gray-800 rounded-2xl p-6 shadow-xl space-y-6 relative"
            >
              <div className="flex justify-between items-start gap-4">
                <div className="space-y-1">
                  <h3 className="text-lg font-bold text-white tracking-tight leading-snug">
                    {selectedBook.title}
                  </h3>
                  <p className="text-sm text-cyan-400">
                    {selectedBook.authors.join(', ')}
                  </p>
                </div>

                <div className="shrink-0 flex items-center space-x-2">
                  <span className={`text-[10px] uppercase font-mono px-2 py-1 rounded font-bold border ${
                    selectedBook.source === 'librivox' 
                      ? 'bg-amber-950 text-amber-300 border-amber-800/40' 
                      : 'bg-indigo-950 text-indigo-300 border-indigo-800/40'
                  }`}>
                    {selectedBook.source === 'librivox' ? 'LIVR' : 'ARCH'}
                  </span>
                </div>
              </div>

              {/* License Citations panel */}
              <div className="bg-[#181C21] border border-gray-800 rounded-xl p-3 flex items-start gap-2.5">
                <Info className="h-4.5 w-4.5 text-cyan-500 shrink-0 mt-0.5" />
                <div className="text-[11px] leading-relaxed text-gray-300">
                  <p className="font-semibold text-white">Licencia y Origen Legal:</p>
                  <p className="text-gray-400">Este libro procede de catálogos y grabaciones de voluntarios.</p>
                  <div className="mt-1.5 flex items-center gap-3">
                    <span className="text-cyan-400 underline font-mono cursor-pointer">{selectedBook.licenseText}</span>
                    <a 
                      href={selectedBook.licenseUrl} 
                      target="_blank" 
                      rel="noreferrer" 
                      className="text-gray-400 hover:text-white flex items-center gap-0.5 shrink-0"
                    >
                      Ver términos <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider font-mono text-gray-500 font-semibold">Resumen de la Obra</p>
                <div className="text-xs text-gray-300 max-h-32 overflow-y-auto leading-relaxed bg-[#161A1F] p-3 rounded-lg border border-gray-800/60 custom-scrollbar">
                  {selectedBook.description?.replace(/<[^>]*>/g, '') || 'Sin descripción disponible para este audiolibro.'}
                </div>
              </div>

              {/* Verified Badge / AI Auditor Panel */}
              <div className="border border-gray-800 bg-[#15191E] rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-1 rounded-lg bg-cyan-950 text-cyan-400">
                      <Sparkles className="h-4.5 w-4.5 text-cyan-400" />
                    </div>
                    <span className="text-xs font-semibold text-white">Auditoría IA de Idioma y Narración</span>
                  </div>

                  {manualVerification ? (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      manualVerification.status === 'verified' && manualVerification.audioOk
                        ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/40'
                        : 'bg-rose-950 text-rose-400 border border-rose-800/40'
                    }`}>
                      {manualVerification.status === 'verified' ? 'CERTIFICADO' : 'FALLIDO'}
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-gray-500">Pendiente</span>
                  )}
                </div>

                {/* Verification results display */}
                {manualVerification ? (
                  <div className="space-y-3 pt-1 text-xs">
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div className="bg-[#1A1F26] p-2 rounded border border-gray-800">
                        <span className="text-gray-500 text-[10px] block">IDIOMA DETECTADO:</span>
                        <span className="font-semibold text-white capitalize">{manualVerification.detectedLanguage || 'No verificado'}</span>
                      </div>
                      <div className="bg-[#1A1F26] p-2 rounded border border-gray-800">
                        <span className="text-gray-500 text-[10px] block">CONFIANZA ESPAÑOL:</span>
                        <span className="font-semibold text-white">{(Number(manualVerification.confidence || 0) * 100).toFixed(1)}%</span>
                      </div>
                    </div>

                    {/* Speech Transcript preview */}
                    <div className="bg-[#181D24] p-3 rounded-lg border border-gray-800 space-y-1">
                      <span className="text-gray-500 text-[10px] block uppercase tracking-wide font-semibold">Transcripción auditada (Muestra vocal):</span>
                      <p className="text-gray-300 italic">"{manualVerification.transcriptionSample || 'No disponible.'}"</p>
                    </div>

                    {/* Linguistic/quality analysis */}
                    <p className="text-[11px] text-gray-400 leading-normal">
                      <strong className="text-gray-300 block text-[10px] font-mono uppercase">Análisis del Narrador Humano:</strong>
                      {manualVerification.analysis || 'Revisión técnica en progreso.'}
                    </p>

                    <div className="flex items-center gap-2 pt-1 text-[11px] text-gray-500">
                      <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                      <span>Licencia pública verificada correctamente.</span>
                    </div>
                  </div>
                ) : currentJob && currentJob.status === 'running' ? (
                  <div className="space-y-3.5 pt-1">
                    <div className="flex justify-between items-center text-[11px] font-mono">
                      <span className="text-cyan-400 animate-pulse flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin text-cyan-400" /> {currentJob.message}
                      </span>
                      <span className="text-gray-300">{currentJob.progress}%</span>
                    </div>

                    {/* Progress Bar wrapper */}
                    <div className="w-full bg-gray-800 h-1.5 rounded-full overflow-hidden">
                      <motion.div 
                        initial={{ width: '0%' }}
                        animate={{ width: `${currentJob.progress}%` }}
                        className="bg-gradient-to-r from-cyan-400 to-indigo-500 h-full"
                      />
                    </div>
                    <p className="text-[10px] text-gray-500 italic">Gemini está analizando la acústica y el acento gramatical en tiempo real...</p>
                  </div>
                ) : (
                  <div className="space-y-3.5 pt-1">
                    <p className="text-xs text-gray-400 leading-normal">
                      ¿Deseas verificar si este audiolibro está realmente en completo idioma español y audible? Nuestro auditor AI descargará temporalmente los primeros bytes de audio del capítulo 1 y ejecutará una validación acústica.
                    </p>
                    <button 
                      onClick={startAIVerification}
                      disabled={loadingDetail || chapters.length === 0}
                      className="w-full bg-cyan-950 hover:bg-cyan-900/85 text-cyan-400 border border-cyan-700/45 py-2.5 rounded-xl font-medium text-xs tracking-wide transition-all cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      <span>Verificar Audio mediante Gemini AI</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Tracks/Chapters list */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs uppercase tracking-wider font-mono text-gray-400 font-semibold">Títulos de Pistas ({chapters.length})</h4>
                  <p className="text-[10px] text-cyan-400 font-mono">Formato mp3 disponible</p>
                </div>

                {loadingDetail ? (
                  <div className="py-12 flex flex-col items-center justify-center space-y-2">
                    <Loader2 className="h-6 w-6 text-cyan-500 animate-spin" />
                    <p className="text-xs text-gray-500">Recuperando índices de capítulos...</p>
                  </div>
                ) : chapters.length === 0 ? (
                  <div className="bg-[#161a1f] p-6 rounded-xl border border-gray-800 text-center text-xs text-gray-500">
                    No se localizaron pistas MP3 de descarga directa. El indexador puede estar retrasado.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
                    {chapters.map((track) => {
                      const isActivePlaying = activeTrack?.trackUrl.includes(encodeURIComponent(track.url));
                      return (
                        <div 
                          key={track.play_order || track.title}
                          className={`flex items-center justify-between p-2.5 rounded-lg border text-xs transition-colors ${
                            isActivePlaying 
                              ? 'bg-cyan-950/20 border-cyan-800/40 text-cyan-300' 
                              : 'bg-[#161A1F] border-gray-800/60 text-gray-300 hover:border-gray-700'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0 pr-4">
                            <span className="text-[10px] font-mono text-gray-500 w-5 text-right shrink-0">
                              {track.play_order || '#'}
                            </span>
                            <span className="truncate font-medium">
                              {track.title}
                            </span>
                          </div>

                          <div className="flex items-center space-x-1 shrink-0">
                            <button 
                              onClick={() => selectTrackForPlayback(track)}
                              className={`p-1.5 rounded-md transition-all ${
                                isActivePlaying 
                                  ? 'bg-cyan-400 text-[#0E1012] hover:bg-cyan-300' 
                                  : 'hover:bg-gray-800 text-gray-400 hover:text-white'
                              }`}
                              title="Escuchar muestra"
                            >
                              {isActivePlaying && isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                            </button>
                            <a 
                              href={track.url}
                              download
                              target="_blank"
                              rel="noreferrer"
                              className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-white"
                              title="Descargar pista MP3"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </motion.div>
          ) : (
            <div className="h-full min-h-[400px] border border-dashed border-gray-800 rounded-2xl flex flex-col items-center justify-center text-center p-8 space-y-4">
              <div className="p-4 bg-gray-900/40 text-gray-600 rounded-full">
                <FileAudio className="h-10 w-10 text-gray-600" />
              </div>
              <div className="max-w-xs space-y-1">
                <p className="font-semibold text-gray-300 text-sm">Exploración de Audiolibros</p>
                <p className="text-xs text-gray-500 leading-normal">
                  Haz clic en cualquiera de los resultados de los catálogos de la izquierda para desplegar auditoría, índice de pistas y descarga de capítulos.
                </p>
              </div>
            </div>
          )}

        </div>

      </div>

      {/* Persistent Bottom Fixed Audio Playback Bar */}
      {activeTrack && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-[#121518] border-t border-gray-800/90 shadow-2xl px-6 py-4 backdrop-blur-md">
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
            
            {/* Playing track name metadata */}
            <div className="flex items-center space-x-3.5 min-w-0 md:w-1/3">
              <div className="p-2.5 bg-cyan-950/50 rounded-xl border border-cyan-800/40 text-cyan-400">
                <Volume2 className="h-5 w-5 animate-pulse" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-cyan-400 font-medium uppercase tracking-wider font-mono">Reproduciendo en Español</p>
                <h5 className="font-semibold text-white text-sm truncate leading-snug">
                  {activeTrack.title}
                </h5>
              </div>
            </div>

            {/* Middle slider & play buttons */}
            <div className="flex items-center space-x-4 w-full md:w-2/5 justify-center">
              <button 
                onClick={togglePrimaryPlayback}
                disabled={playerLoading}
                className="p-3 bg-gradient-to-tr from-cyan-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white rounded-full transition-all shrink-0 cursor-pointer shadow-lg disabled:opacity-50"
              >
                {playerLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : isPlaying ? <Pause className="h-5 w-5 fill-white" /> : <Play className="h-5 w-5 fill-white" />}
              </button>

              <span className="text-[11px] font-mono text-gray-500 w-10 text-right">
                {formatAudioTime(currentTime)}
              </span>

              {/* Styled Range Timeline */}
              <input 
                type="range" 
                min={0}
                max={duration || 100}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-1 bg-gray-800 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />

              <span className="text-[11px] font-mono text-gray-500 w-10">
                {formatAudioTime(duration)}
              </span>
            </div>

            {/* Quick Action bar */}
            <div className="md:w-1/3 flex flex-col sm:flex-row items-center justify-end gap-3 shrink-0">
              {/* Regulador de velocidad de reproducción */}
              <div className="flex items-center space-x-1 bg-[#181C21] border border-gray-800 rounded-xl p-1 text-xs">
                <span className="text-[10px] text-gray-400 font-mono px-1">Vel:</span>
                {[0.75, 1.0, 1.25, 1.5, 2.0].map((speed) => (
                  <button
                    key={speed}
                    onClick={() => setPlaybackSpeed(speed)}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-mono font-semibold transition-all cursor-pointer ${
                      playbackSpeed === speed 
                        ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 text-white shadow font-bold' 
                        : 'text-gray-400 hover:text-white hover:bg-gray-800'
                    }`}
                  >
                    {speed}x
                  </button>
                ))}
              </div>

              <a 
                href={selectedBook?.downloadUrl || '#'} 
                target="_blank" 
                rel="noreferrer" 
                className="flex items-center space-x-1.5 bg-gray-800 hover:bg-gray-750 text-white px-4 py-2 rounded-xl text-xs font-semibold transition-all shrink-0 cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span>Descargar Completo</span>
              </a>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
