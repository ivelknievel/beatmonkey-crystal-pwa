import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Video, Clipboard, RefreshCw, X, AlertCircle, Loader2 } from 'lucide-react';
import {
  validateYoutubeUrl,
  submitYoutubeJob,
  listYoutubeJobs,
  type YoutubeJob,
  type JobStatus,
} from '../services/youtubeDownloads';
import { useAuthStore } from '../stores/useAuthStore';

const DUTCH_STATUS_LABELS: Record<JobStatus, string> = {
  pending: 'In wachtrij',
  running: 'Bezig',
  completed: 'Voltooid',
  failed: 'Mislukt',
  uncertain: 'Status onzeker, ververs taken voordat opnieuw indienen',
};

const DRAFT_STORAGE_PREFIX = 'bm_yt_draft_';

function getStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
  } catch {
    // sessionStorage blocked
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // localStorage blocked
  }
  return null;
}

export function YouTubeDownloadPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState('mp3');
  const [loading, setLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobs, setJobs] = useState<YoutubeJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAuthError, setIsAuthError] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [exhaustedBudget, setExhaustedBudget] = useState(false);

  const accountScope = useAuthStore((s) => s.accountScope);
  const logout = useAuthStore((s) => s.logout);

  const pollCountRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const pollAbortControllerRef = useRef<AbortController | null>(null);
  const submitAbortControllerRef = useRef<AbortController | null>(null);
  const fetchAbortControllerRef = useRef<AbortController | null>(null);
  const currentScopeRef = useRef<string | null>(accountScope);
  const isSubmittingRef = useRef<boolean>(false);

  // Sync ref to avoid stale closure during rapid unmount / auth switch
  useEffect(() => {
    currentScopeRef.current = accountScope;
  }, [accountScope]);

  // Account-scoped draft key
  const draftKey = accountScope ? `${DRAFT_STORAGE_PREFIX}${accountScope}` : null;

  // Stop polling & abort poll requests
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pollAbortControllerRef.current) {
      pollAbortControllerRef.current.abort();
      pollAbortControllerRef.current = null;
    }
  }, []);

  // Abort all requests across controllers
  const abortAllRequests = useCallback(() => {
    if (pollAbortControllerRef.current) {
      pollAbortControllerRef.current.abort();
      pollAbortControllerRef.current = null;
    }
    if (submitAbortControllerRef.current) {
      submitAbortControllerRef.current.abort();
      submitAbortControllerRef.current = null;
    }
    if (fetchAbortControllerRef.current) {
      fetchAbortControllerRef.current.abort();
      fetchAbortControllerRef.current = null;
    }
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Reset on EVERY scope change: abort all requests, clear jobs/errors/loading/url, restore B draft if any
  useEffect(() => {
    abortAllRequests();
    setJobs([]);
    setError(null);
    setIsAuthError(false);
    setLoading(false);
    setJobsLoading(false);
    setClipboardNotice(null);
    setExhaustedBudget(false);
    pollCountRef.current = 0;

    if (!accountScope) {
      setUrl('');
      return;
    }

    const key = `${DRAFT_STORAGE_PREFIX}${accountScope}`;
    const storage = getStorageSafe();
    let saved = '';
    if (storage) {
      try {
        const item = storage.getItem(key);
        if (item !== null) {
          saved = item;
        }
      } catch {
        // Safe wrapper
      }
    }
    setUrl(saved);
  }, [accountScope, abortAllRequests]);

  // Save draft whenever url changes
  const handleUrlChange = (newVal: string) => {
    setUrl(newVal);
    setError(null);
    setIsAuthError(false);
    if (draftKey) {
      const storage = getStorageSafe();
      if (storage) {
        try {
          storage.setItem(draftKey, newVal);
        } catch {
          // Safe wrapper
        }
      }
    }
  };

  // Clear draft
  const clearDraft = useCallback(() => {
    setUrl('');
    if (draftKey) {
      const storage = getStorageSafe();
      if (storage) {
        try {
          storage.removeItem(draftKey);
        } catch {
          // Safe wrapper
        }
      }
    }
  }, [draftKey]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortAllRequests();
    };
  }, [abortAllRequests]);

  // Restore jobs from server
  const fetchJobs = useCallback(
    async (manualResetBudget = false) => {
      if (!accountScope) return;
      const expectedScope = accountScope;

      if (fetchAbortControllerRef.current) {
        fetchAbortControllerRef.current.abort();
        fetchAbortControllerRef.current = null;
      }
      const ac = new AbortController();
      fetchAbortControllerRef.current = ac;

      if (manualResetBudget) {
        pollCountRef.current = 0;
        setExhaustedBudget(false);
      }

      setJobsLoading(true);
      try {
        const serverJobs = await listYoutubeJobs(ac.signal);
        // Generation guard
        if (currentScopeRef.current !== expectedScope || ac.signal.aborted) return;
        setJobs(serverJobs);
        setError(null);
        setIsAuthError(false);
      } catch (err: any) {
        if (ac.signal.aborted || currentScopeRef.current !== expectedScope) return;
        if (/sessie verlopen|401/i.test(err?.message || '')) {
          setIsAuthError(true);
        }
        setError(err?.message || 'Fout bij ophalen van taken');
      } finally {
        if (currentScopeRef.current === expectedScope && !ac.signal.aborted) {
          setJobsLoading(false);
        }
      }
    },
    [accountScope]
  );

  // Restore jobs when panel opens or account becomes ready
  useEffect(() => {
    if (isOpen && accountScope) {
      void fetchJobs(true);
    }
  }, [isOpen, accountScope, fetchJobs]);

  // Close handler: abort poll requests and timer
  const handleClose = useCallback(() => {
    stopPolling();
    setIsOpen(false);
  }, [stopPolling]);

  // Bounded polling loop: max 60 polls, 5s interval, pauses when hidden/offline/submitting
  useEffect(() => {
    if (!isOpen || !accountScope) {
      stopPolling();
      return;
    }

    const hasActiveJobs = jobs.some((j) => j.status === 'pending' || j.status === 'running');
    if (!hasActiveJobs) {
      stopPolling();
      return;
    }

    let isDisposed = false;

    const scheduleNext = () => {
      stopPolling();
      if (isDisposed || !accountScope) return;

      if (pollCountRef.current >= 60) {
        setExhaustedBudget(true);
        return;
      }

      // Pause while document hidden or offline
      if (typeof document !== 'undefined' && (document.hidden || !navigator.onLine)) {
        return;
      }

      pollTimerRef.current = window.setTimeout(async () => {
        if (isDisposed || !accountScope) return;
        if (document.hidden || !navigator.onLine) {
          scheduleNext();
          return;
        }

        // Do not poll while submission is active
        if (isSubmittingRef.current) {
          scheduleNext();
          return;
        }

        const expectedScope = accountScope;
        pollCountRef.current += 1;

        try {
          const ac = new AbortController();
          pollAbortControllerRef.current = ac;
          const updated = await listYoutubeJobs(ac.signal);

          if (isDisposed || currentScopeRef.current !== expectedScope) return;
          setJobs(updated);
          scheduleNext();
        } catch (pollErr: any) {
          if (isDisposed || currentScopeRef.current !== expectedScope) return;
          // Poll auth error: stop polling and show reauth, do not swallow
          if (/sessie verlopen|401/i.test(pollErr?.message || '')) {
            setIsAuthError(true);
            setError(pollErr?.message || 'Sessie verlopen. Log opnieuw in om door te gaan.');
            stopPolling();
            return;
          }
          // Resume schedule on non-auth transient error
          scheduleNext();
        }
      }, 5000);
    };

    scheduleNext();

    const handleVisibilityOrOnline = () => {
      if (!document.hidden && navigator.onLine) {
        scheduleNext();
      } else {
        stopPolling();
      }
    };

    window.addEventListener('online', handleVisibilityOrOnline);
    window.addEventListener('offline', handleVisibilityOrOnline);
    document.addEventListener('visibilitychange', handleVisibilityOrOnline);

    return () => {
      isDisposed = true;
      stopPolling();
      window.removeEventListener('online', handleVisibilityOrOnline);
      window.removeEventListener('offline', handleVisibilityOrOnline);
      document.removeEventListener('visibilitychange', handleVisibilityOrOnline);
    };
  }, [isOpen, jobs, accountScope, stopPolling]);

  // Optional Plakken button on user click navigator.clipboard.readText with generation guard
  const handlePasteClick = async () => {
    setClipboardNotice(null);
    const scopeAtStart = accountScope;
    try {
      if (!navigator.clipboard?.readText) {
        throw new Error('Clipboard API niet ondersteund');
      }
      const text = await navigator.clipboard.readText();
      // Guard against account switch during clipboard await
      if (currentScopeRef.current !== scopeAtStart) {
        return;
      }
      if (text && typeof text === 'string') {
        handleUrlChange(text.trim());
      }
    } catch {
      if (currentScopeRef.current !== scopeAtStart) return;
      // Safe fallback message without overwriting input
      setClipboardNotice('Klembord kon niet gelezen worden. Gebruik handmatig plakken.');
      setError('Klembord niet toegankelijk. Plak de URL handmatig in het veld.');
    }
  };

  // Submit job
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsAuthError(false);
    setClipboardNotice(null);

    const trimmed = url.trim();
    if (!trimmed) {
      setError('Voer een geldige YouTube URL in.');
      return;
    }

    if (!validateYoutubeUrl(trimmed)) {
      setError('Ongeldige YouTube URL. Controleer de link en probeer opnieuw.');
      return;
    }

    if (!accountScope) {
      setIsAuthError(true);
      setError('Sessie verlopen. Log opnieuw in om door te gaan.');
      return;
    }

    const expectedScope = accountScope;
    setLoading(true);
    isSubmittingRef.current = true;

    if (submitAbortControllerRef.current) {
      submitAbortControllerRef.current.abort();
      submitAbortControllerRef.current = null;
    }
    const ac = new AbortController();
    submitAbortControllerRef.current = ac;

    try {
      // 202 accepted only
      const newJob = await submitYoutubeJob(trimmed, { fmt: format, signal: ac.signal });

      if (currentScopeRef.current !== expectedScope || ac.signal.aborted) return;

      // Succeeded: dedupe by job.id, update jobs list and clear input draft
      setJobs((prev) => [newJob, ...prev.filter((j) => j.id !== newJob.id)]);
      clearDraft();
      pollCountRef.current = 0;
      setExhaustedBudget(false);
    } catch (err: any) {
      if (ac.signal.aborted || currentScopeRef.current !== expectedScope) return;

      if (/sessie verlopen|401/i.test(err?.message || '')) {
        setIsAuthError(true);
        // Retain draft in state & storage!
        setError(err?.message || 'Sessie verlopen. Log opnieuw in om door te gaan.');
      } else if (err?.status === 'uncertain' || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        // NEVER create fabricated tempjob on abort; keep draft and show warning message
        setError('Status onzeker, ververs taken voordat opnieuw indienen');
      } else {
        setError(err?.message || 'Fout bij indienen van download');
      }
    } finally {
      isSubmittingRef.current = false;
      if (currentScopeRef.current === expectedScope && !ac.signal.aborted) {
        setLoading(false);
      }
    }
  };

  // Synchronous render guard: if no accountScope, render null
  if (!accountScope) {
    return null;
  }

  return (
    <div className="w-full">
      {!isOpen ? (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-red-600/20 to-red-500/10 hover:from-red-600/30 hover:to-red-500/20 border border-red-500/30 text-white font-medium flex items-center justify-center gap-2 transition-all cursor-pointer shadow-sm text-sm sm:text-base focus:outline-none focus:ring-2 focus:ring-red-500/50"
        >
          <Video className="w-5 h-5 text-red-500" />
          <span>YouTube-set toevoegen</span>
        </button>
      ) : (
        <div className="rounded-2xl border border-[var(--color-crystal-border,#222230)] bg-[var(--color-crystal-card,#1a1a26)] p-4 sm:p-6 space-y-4 shadow-xl">
          <div className="flex items-center justify-between border-b border-[var(--color-crystal-border,#222230)] pb-3">
            <div className="flex items-center gap-2 text-white font-semibold">
              <Video className="w-5 h-5 text-red-500" />
              <span>YouTube-set toevoegen</span>
            </div>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Sluiten"
              className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/20"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="yt-download-url"
                className="block text-xs sm:text-sm font-medium text-gray-300"
              >
                YouTube URL
              </label>
              <div className="relative flex items-center gap-2">
                <input
                  id="yt-download-url"
                  type="url"
                  value={url}
                  onChange={(e) => handleUrlChange(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck="false"
                  disabled={loading}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--color-crystal-surface,#12121a)] border border-[var(--color-crystal-border,#222230)] text-white placeholder-gray-500 focus:outline-none focus:border-[var(--color-crystal-cyan,#00e5ff)] focus:ring-1 focus:ring-[var(--color-crystal-cyan,#00e5ff)] transition-colors text-[16px] leading-normal"
                />
                <button
                  type="button"
                  onClick={handlePasteClick}
                  disabled={loading}
                  className="px-3 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-gray-200 text-xs sm:text-sm font-medium flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-white/20"
                >
                  <Clipboard className="w-4 h-4" />
                  <span>Plakken</span>
                </button>
              </div>
            </div>

            {/* Error or auth message live region */}
            {(error || clipboardNotice) && (
              <div
                role="alert"
                aria-live="assertive"
                className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs sm:text-sm flex flex-col gap-2"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>{error || clipboardNotice}</span>
                </div>
                {isAuthError && (
                  <div className="pl-6 pt-1">
                    <button
                      type="button"
                      onClick={() => logout()}
                      className="text-xs font-semibold text-white underline hover:text-[var(--color-crystal-cyan,#00e5ff)] cursor-pointer"
                    >
                      Opnieuw inloggen (concept blijft bewaard)
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="flex items-center gap-2">
                <label htmlFor="yt-format" className="text-xs text-gray-400">
                  Formaat:
                </label>
                <select
                  id="yt-format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  disabled={loading}
                  className="bg-[var(--color-crystal-surface,#12121a)] border border-[var(--color-crystal-border,#222230)] text-xs text-white rounded-lg px-2 py-1.5 focus:outline-none focus:border-[var(--color-crystal-cyan,#00e5ff)]"
                >
                  <option value="mp3">MP3</option>
                </select>
              </div>

              <button
                type="submit"
                disabled={loading || !url.trim()}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white font-semibold text-xs sm:text-sm flex items-center gap-2 cursor-pointer transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-red-400/50"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                <span>Download starten</span>
              </button>
            </div>
          </form>

          {/* Job List / Status Section */}
          <div className="border-t border-[var(--color-crystal-border,#222230)] pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Recente downloads
              </span>
              <button
                type="button"
                onClick={() => fetchJobs(true)}
                disabled={jobsLoading}
                aria-label="Status vernieuwen"
                className="text-xs text-[var(--color-crystal-cyan,#00e5ff)] hover:underline flex items-center gap-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-[var(--color-crystal-cyan,#00e5ff)] p-1 rounded"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${jobsLoading ? 'animate-spin' : ''}`} />
                <span>Status vernieuwen</span>
              </button>
            </div>

            {exhaustedBudget && (
              <div
                role="status"
                className="p-2.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs flex items-center justify-between"
              >
                <span>Automatisch bijwerken gepauzeerd.</span>
                <button
                  type="button"
                  onClick={() => fetchJobs(true)}
                  className="font-medium underline hover:text-yellow-300 ml-2"
                >
                  Status vernieuwen
                </button>
              </div>
            )}

            {jobs.length === 0 ? (
              <p className="text-xs text-gray-500 py-2 text-center">
                Geen actieve of recente downloads gevonden.
              </p>
            ) : (
              <div
                aria-live="polite"
                aria-relevant="additions text"
                className="space-y-2 max-h-60 overflow-y-auto pr-1"
              >
                {jobs.map((job) => {
                  const label = DUTCH_STATUS_LABELS[job.status] || job.status;
                  const isPending = job.status === 'pending';
                  const isRunning = job.status === 'running';
                  const isDone = job.status === 'completed';
                  const isFailed = job.status === 'failed';
                  const isUncertain = job.status === 'uncertain';

                  return (
                    <div
                      key={job.id}
                      className="p-3 rounded-xl bg-[var(--color-crystal-surface,#12121a)] border border-[var(--color-crystal-border,#222230)] flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-white truncate font-medium">{job.url}</div>
                        <div className="flex items-center gap-2 mt-1">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full font-medium ${
                              isDone
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                : isFailed
                                ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                                : isUncertain
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                                : 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20'
                            }`}
                          >
                            {(isPending || isRunning) && (
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                            )}
                            {label}
                          </span>
                          {job.created_at && (
                            <span className="text-gray-500 text-[10px]">
                              {new Date(job.created_at).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </span>
                          )}
                        </div>
                        {job.error && (
                          <div className="text-red-400 mt-1 text-[11px] truncate">{job.error}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default YouTubeDownloadPanel;
