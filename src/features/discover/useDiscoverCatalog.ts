import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import * as api from '../../shared/api/index';
import { matches, type InstalledLookup, type DiscoverFeedback } from './discoverControllerTypes';

/** Catalog requests and installed answers are stamped with their repository identity. */
export function useDiscoverCatalog({ active, modelsDir, resetFeedback, setIncludeCompanions, setError }: {
  active: boolean; modelsDir: string; resetFeedback: () => void;
  setIncludeCompanions: Dispatch<SetStateAction<boolean>>; setError: DiscoverFeedback['setError'];
}) {
  const [format, setFormat] = useState<api.HfSearchFormat>('all');
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<api.HfSortKey>("trendingScore");
  const [results, setResults] = useState<api.HfModel[]>([]);
  const [listed, setListed] = useState(false);
  const [selected, setSelected] = useState<api.HfModel | null>(null);
  // The selected repository's file tree, stamped with the repository it was
  // read for. Only this answer establishes what can be downloaded in-app.
  const [inspection, setInspection] = useState<(api.HfRepositoryInspection & { repo: string }) | null>(null);
  const [inspectionError, setInspectionError] = useState<{ repo: string; generation: number; message: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  // Which of the selected repository's files this machine already holds.
  // Activation refuses to overwrite, so offering a download for one of these
  // could only ever produce an error; the row says "Installed" instead.
  //
  // The answer is stamped with the repository and destination it was read for
  // and only used while both still match. Two repositories routinely publish
  // the same file name, so an answer carried across a selection change would
  // mark the wrong rows — and it would do so during the render before the
  // lookup effect had a chance to clear anything.
  const [installedLookup, setInstalledLookup] = useState<InstalledLookup | null>(null);
  const [installedRevision, setInstalledRevision] = useState(0);
  const searchGeneration = useRef(0);
  const inspectGeneration = useRef(0);
  const installedGeneration = useRef(0);

  const [snapshots, setSnapshots] = useState<{ repo: string; destination: string; artifacts: api.ModelArtifact[] } | null>(null);
  const [checkingSnapshots, setCheckingSnapshots] = useState(false);
  // What the selected repository's own files allow under the chosen filter.
  // Tags, the configured engine and a missing, loading or failed inspection
  // never make an action available.
  const inspected = selected && inspection?.repo === selected.id ? inspection : null;
  const currentInspectionError = selected && inspectionError?.repo === selected.id && inspectionError.generation === inspectGeneration.current ? inspectionError : null;
  const files = inspected && format !== 'safetensors' && format !== 'mlx' ? inspected.gguf_files : null;
  const snapshotCandidate = !!inspected && format !== 'gguf' && inspected.has_root_safetensors;
  const safetensorsFiles = inspected && format !== 'gguf' ? inspected.safetensors_files : null;
  const hasSnapshotChoices = snapshotCandidate || !!safetensorsFiles?.length;
  const noInAppDownload = !!inspected && !files?.length && !hasSnapshotChoices;
  // The header names only formats found in the repository's files; neither
  // the search filter nor a task tag is evidence of how weights are stored.
  const fileFormats = inspected ? [
    ...(inspected.gguf_files.length > 0 ? ['GGUF'] : []),
    ...(inspected.safetensors_files.length > 0 ? ['Safetensors'] : []),
  ] : [];

  // An empty query is a listing, not a mistake: the panel opens on the catalog
  // in the selected order and the search box narrows it from there.
  const runSearch = useCallback(async (term: string, order: api.HfSortKey) => {
    const generation = ++searchGeneration.current;
    // A file listing already in flight belongs to a repository that is about
    // to leave the results, so retire it with the selection it was for.
    inspectGeneration.current += 1;
    resetFeedback();
    setSelected(null);
    setInspection(null);
    setInspectionError(null);
    setLoadingFiles(false);
    setSearching(true);
    try {
      const next = await api.hfSearchModels(term.trim(), 30, order, format);
      if (generation !== searchGeneration.current) return;
      setResults(next);
      setListed(true);
    } catch (caught) {
      if (generation !== searchGeneration.current) return;
      setResults([]);
      setListed(true);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  }, [format, resetFeedback, setError]);

  // Seed the listing the first time the panel is actually shown, so a panel
  // the user has never opened never spends a request.
  const opened = useRef('');
  useEffect(() => {
    if (!active || opened.current === format) return;
    opened.current = format;
    void runSearch(query, sort);
  }, [active, runSearch, query, sort, format]);

  useEffect(() => () => {
    searchGeneration.current += 1; inspectGeneration.current += 1; installedGeneration.current += 1;
    // StrictMode replays mount effects while preserving refs. Retire the
    // listing marker with its request so the next setup can load the catalog.
    opened.current = '';
  }, []);

  // Sort is part of the request, so changing it re-runs what is on screen.
  const changeSort = (order: api.HfSortKey) => {
    setSort(order);
    if (opened.current) void runSearch(query, order);
  };

  const inspect = async (model: api.HfModel) => {
    const generation = ++inspectGeneration.current;
    setSelected(model);
    setIncludeCompanions(false);
    setInspection(null);
    setInspectionError(null);
    resetFeedback();
    setLoadingFiles(true);
    try {
      const next = await api.hfModelFiles(model.id);
      if (generation === inspectGeneration.current) setInspection({ ...next, repo: model.id });
    } catch (caught) {
      if (generation === inspectGeneration.current) setInspectionError({ repo: model.id, generation, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      if (generation === inspectGeneration.current) setLoadingFiles(false);
    }
  };

  useEffect(() => {
    const generation = ++installedGeneration.current;
    if (!selected || !files || files.length === 0) {
      setInstalledLookup(null);
      return;
    }
    const repoId = selected.id;
    const destination = modelsDir;
    const paths = files.map((file) => file.path);
    // Re-reading the same repository keeps the marks it already has, so a
    // refresh does not flicker; a different repository or destination starts
    // from nothing known.
    setInstalledLookup((current) => matches(current, repoId, destination)
      ? { ...current!, state: "pending" }
      : { repoId, modelsDir: destination, entries: {}, state: "pending" });
    void (async () => {
      try {
        const found = await api.hfInstalledFiles(repoId, paths, destination);
        if (generation !== installedGeneration.current) return;
        setInstalledLookup({ repoId, modelsDir: destination, entries: Object.fromEntries(found.map((entry) => [entry.path, entry])), state: "ready" });
      } catch {
        if (generation !== installedGeneration.current) return;
        // A supporting lookup: losing it costs fresh marks, not the panel,
        // and a download that then collides still reports its own error. Say
        // so in the header, and keep what is already known — a file this
        // session just downloaded is still on disk whatever the lookup says.
        setInstalledLookup((current) => matches(current, repoId, destination)
          ? { ...current!, state: "unavailable" }
          : { repoId, modelsDir: destination, entries: {}, state: "unavailable" });
      }
    })();
  }, [selected, files, modelsDir, installedRevision]);

  useEffect(() => {
    let retired = false;
    setSnapshots(null);
    if (!selected || !hasSnapshotChoices) { setCheckingSnapshots(false); return; }
    const repo = selected.id;
    setCheckingSnapshots(true);
    void api.hfInstalledSnapshots(repo, modelsDir).then(artifacts => {
      if (!retired) setSnapshots({ repo, destination: modelsDir, artifacts });
    }).catch(() => { /* Lookup failure still allows a verified, no-replace retry. */ }).finally(() => {
      if (!retired) setCheckingSnapshots(false);
    });
    return () => { retired = true; };
  }, [selected, hasSnapshotChoices, modelsDir, installedRevision]);

  // Only an answer read for what is on screen right now may mark a row.
  const lookup = selected && matches(installedLookup, selected.id, modelsDir) ? installedLookup : null;
  const installed = lookup?.entries ?? {};
  const installedUnknown = lookup?.state === "unavailable";
  // Until the first answer lands, whether a file is already there is unknown,
  // and a download started on a guess would collide at activation.
  const checkingInstalled = !!selected && !!files && files.length > 0 && lookup?.state !== "ready" && !installedUnknown;
  const repoSnapshots = snapshots?.repo === selected?.id && snapshots?.destination === modelsDir ? snapshots.artifacts : [];
  const wholeSnapshots = repoSnapshots.filter(artifact => artifact.selected_file === undefined);
  const installedSnapshot = wholeSnapshots.find(artifact => !artifact.incomplete && artifact.missing.length === 0);

  const changeFormat = (value: api.HfSearchFormat) => {
    searchGeneration.current += 1; inspectGeneration.current += 1;
    setFormat(value); setSelected(null); setInspection(null); setLoadingFiles(false); setResults([]);
    resetFeedback(); opened.current = '';
  };
  return { format, query, setQuery, sort, results, listed, selected, loadingFiles, searching,
    inspectGeneration, files, snapshotCandidate, safetensorsFiles, noInAppDownload, fileFormats,
    currentInspectionError, installed, installedUnknown, checkingInstalled, repoSnapshots,
    wholeSnapshots, installedSnapshot, checkingSnapshots, setInstalledLookup, setInstalledRevision,
    runSearch, changeSort, changeFormat, inspect };
}
