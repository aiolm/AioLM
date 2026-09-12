import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppConfig } from "../../shared/api/types";
import type { AppStore } from "../../shared/state/store";
import { findModelTuningProfile } from "../../shared/config/qwenDefaults";
import { isKnownSelectValue, parseChatOptions, parseServerArgs, parseNumericInput, SPEC_DRAFT_NGL_OPTIONS, SPEC_TYPE_OPTIONS } from "../../shared/config/tuningValidation";
import { draftStillCurrent } from "./tuningAsync";
import { projectorChangeAllowed } from "../chat/visionState";
import type { ConfigPatch } from "../../shared/state/configSaveQueue";
import { replaceServerOption, type OptionOccurrence, type ServerOption } from '../../shared/config/serverOptions';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { serverOptionsText } from '../../shared/i18n/serverOptionsI18n';
import { useI18n } from "../../shared/i18n/i18n";
import { modelDisplayName, normalizeDisplayPath } from "../../shared/lib/displayPaths";
import { validateTuningRelations } from "../../shared/config/tuningRelations";
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import type { ChatOptionField, NumericField, NumericKey, ServerTextKey } from "./tuningFields";
import { SERVER_FIELDS, MTP_FIELDS, REASONING_FIELDS, SAMPLING_FIELDS, ADVANCED_SAMPLING_FIELDS } from './tuningFields';
import { useEditorDraft } from '../../shared/state/draftGuard';
import { executionText } from '../../shared/i18n/executionI18n';
import { normalizeSamplerChain } from "./TuningSamplerChain";
import { canonicalResetKey, resetAllTuning, resetTuningField, usesRuntimeDefault } from "../../shared/config/tuningDefaults";
import {
  commitChatOptionField, commitNumericField, performApplyRestart,
  SERVER_FIELD_LABEL_KEYS, SERVER_TEXT_LABEL_KEYS, serverPathKeys, type TuningPhase,
} from "./tuningControllerHelpers";

export type { TuningPhase } from "./tuningControllerHelpers";

/**
 * Owns Tuning's persistence lifecycle: draft/dirty state for every field group,
 * the debounced-commit handlers that patch `store.cfg`, and the stop/start
 * "apply restart" flow with rollback. `cfg` is only exercised by handlers that
 * are reachable exclusively from the panel's own JSX, which the panel renders
 * only once `store.cfg` is defined — the `if (!cfg) return;` guards here exist
 * because that guarantee crosses a hook boundary TypeScript can't see through,
 * not because these code paths are expected to run before the config loads.
 */
export function useTuningController(store: AppStore, options: readonly ServerOption[] = []) {
  const { locale, t } = useI18n();
  const cfg = store.cfg;
  const resetValues = useMemo(() => tuningResetValues(options), [options]);
  const modelProfileName = cfg ? findModelTuningProfile(cfg.active_model, cfg.active_build)?.name ?? null : null;
  const [phase, setPhase] = useState<TuningPhase>("idle");
  const [resetting, setResetting] = useState(false);
  const [flash, notify, dismissFlash] = useFlashMessage();
  const [serverArgsDraft, setServerArgsDraft] = useState("");
  const [chatOptionsDraft, setChatOptionsDraft] = useState("{}");
  const [serverArgsDirty, setServerArgsDirty] = useState(false);
  const [chatOptionsDirty, setChatOptionsDirty] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [numericDrafts, setNumericDrafts] = useState<Partial<Record<NumericKey, string>>>({});
  const [chatOptionDrafts, setChatOptionDrafts] = useState<Record<string, string>>({});
  const [chatOptionSelectModes, setChatOptionSelectModes] = useState<Record<string, "select" | "custom">>({});
  const [serverTextDrafts, setServerTextDrafts] = useState<Partial<Record<ServerTextKey, string>>>({});
  const [changedServerFields, setChangedServerFields] = useState<string[]>([]);
  // Presets and the Qwen profile overwrite every tuning value, so they are
  // confirmed like the other destructive actions in the app.
  const [pendingBulkChange, setPendingBulkChange] = useState<{ title: string; description: string; confirmLabel: string; run: () => void } | null>(null);
  const serverArgsDraftRef = useRef("");
  const chatOptionsDraftRef = useRef("{}");
  const applyLockRef = useRef(false);
  const getConfig = store.getConfig;
  const discardDrafts = useCallback(() => {
    setNumericDrafts({}); setChatOptionDrafts({}); setServerTextDrafts({}); setChatOptionSelectModes({});
    setServerArgsDirty(false); setChatOptionsDirty(false); setAdvancedError(null);
    const current = getConfig();
    serverArgsDraftRef.current = current?.server_args.join('\n') ?? '';
    chatOptionsDraftRef.current = JSON.stringify(current?.chat_options ?? {}, null, 2);
    setServerArgsDraft(serverArgsDraftRef.current); setChatOptionsDraft(chatOptionsDraftRef.current);
  }, [getConfig]);
  useEffect(() => {
    discardDrafts(); dismissFlash(); setPhase('idle'); setChangedServerFields([]); setPendingBulkChange(null);
  }, [cfg?.active_model, discardDrafts, dismissFlash]);
  useEditorDraft({
    dirty: serverArgsDirty || chatOptionsDirty || Object.keys(numericDrafts).length > 0 || Object.keys(chatOptionDrafts).length > 0 || Object.keys(serverTextDrafts).length > 0,
    discard: discardDrafts,
    save: async () => {
      try {
        const patch: Partial<AppConfig> = { ...serverTextDrafts };
        const numeric: Record<string, number> = {};
        for (const [key, raw] of Object.entries(numericDrafts)) {
          const field = [...SERVER_FIELDS, ...MTP_FIELDS, ...REASONING_FIELDS, ...SAMPLING_FIELDS].find(item => item.key === key);
          const value = field ? parseNumericInput(raw, field.step) : null;
          if (!field || value === null || value < field.min || value > field.max) throw new Error(`${key}: ${executionText[locale].invalidNumber}`);
          numeric[key] = value;
        }
        Object.assign(patch, numeric);
        const chat: Record<string, number> = {};
        for (const [key, raw] of Object.entries(chatOptionDrafts)) {
          const field = ADVANCED_SAMPLING_FIELDS.find(item => item.key === key);
          const value = field ? parseNumericInput(raw, field.step) : null;
          if (!field || value === null || value < field.min || value > field.max) throw new Error(`${key}: ${executionText[locale].invalidNumber}`);
          chat[key] = value;
        }
        if (serverArgsDirty) patch.server_args = parseServerArgs(serverArgsDraftRef.current);
        const parsedChat = chatOptionsDirty ? parseChatOptions(chatOptionsDraftRef.current) : null;
        if (patch.mmproj !== undefined && !projectorChangeAllowed(store.status.state)) throw new Error(t('ui.stopBeforeProjector'));
        await store.updateConfig(current => ({ ...patch, ...(parsedChat || Object.keys(chat).length ? { chat_options: { ...(parsedChat ?? current.chat_options), ...chat } } : {}) }));
        discardDrafts(); return true;
      } catch (cause) { setAdvancedError(String(cause)); return false; }
    },
  });
  const clearFieldDrafts = (key?: string) => {
    const resetKey = key ? canonicalResetKey(key) : undefined;
    const withoutKey = <T extends Record<string, unknown>>(drafts: T): T => {
      if (!resetKey) return {} as T;
      const next = { ...drafts }; delete next[resetKey]; return next;
    };
    setNumericDrafts(withoutKey);
    setServerTextDrafts(withoutKey);
    setChatOptionDrafts(withoutKey);
    setChatOptionSelectModes(withoutKey);
  };

  useEffect(() => {
    if (!cfg) return;
    if (!serverArgsDirty) {
      const next = cfg.server_args.join("\n");
      serverArgsDraftRef.current = next;
      setServerArgsDraft(next);
    }
    if (!chatOptionsDirty) {
      const next = JSON.stringify(cfg.chat_options, null, 2);
      chatOptionsDraftRef.current = next;
      setChatOptionsDraft(next);
    }
  }, [cfg, serverArgsDirty, chatOptionsDirty]);

  const projectorEditable = projectorChangeAllowed(store.status.state);
  const configMutationsDisabled = phase === "applying" || store.busy || resetting;
  const relationWarnings = cfg ? validateTuningRelations({
    ctxSize: usesRuntimeDefault(cfg, "ctx_size") ? NaN : cfg.ctx_size,
    parallel: usesRuntimeDefault(cfg, "parallel") ? NaN : cfg.parallel,
    ngl: usesRuntimeDefault(cfg, "ngl") ? NaN : cfg.ngl,
    temperature: usesRuntimeDefault(cfg, "temperature") ? NaN : cfg.temperature,
    dynatempRange: Number(cfg.chat_options?.dynatemp_range ?? 0),
    topP: usesRuntimeDefault(cfg, "top_p") ? NaN : cfg.top_p,
    minP: Number(cfg.chat_options?.min_p ?? 0),
  }) : [];

  const numericFieldLabel = (field: NumericField): string => {
    const key = SERVER_FIELD_LABEL_KEYS[field.key];
    return key ? t(`ui.${key}`) : field.label;
  };

  const savePatch = async (patch: ConfigPatch<AppConfig>, failureLabel: string): Promise<boolean> => {
    if (applyLockRef.current) return false;
    try {
      await store.updateConfig(patch);
      return true;
    } catch (error) {
      setPhase("failed");
      notify(`${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const commitContext = { locale, notify, savePatch, setPhase };

  const commitNumeric = async (field: NumericField, raw: string) => {
    if (applyLockRef.current || !cfg) return;
    const parsed = parseNumericInput(raw, field.step);
    if (parsed === null || parsed < field.min || parsed > field.max) return;
    await commitNumericField(cfg, field, raw, numericFieldLabel, setNumericDrafts, setChangedServerFields, commitContext);
  };

  const commitChatOption = async (field: ChatOptionField, raw: string) => {
    if (applyLockRef.current || !cfg) return;
    const parsed = parseNumericInput(raw, field.step);
    if (parsed === null || parsed < field.min || parsed > field.max) return;
    await commitChatOptionField(cfg, field, raw, setChatOptionDrafts, setChatOptionSelectModes, commitContext);
  };

  const updateFlash = (value: string) => {
    if (applyLockRef.current) return;
    const normalized = value === "on" || value === "off" ? value : "auto";
    void savePatch({ flash_attn: normalized }, t("ui.saveFailedFor", { label: t("ui.flashAttention") }));
    setPhase("dirty");
  };

  const updateServerText = (key: ServerTextKey, value: string) => {
    if (applyLockRef.current) return;
    void savePatch({ [key]: value } as Partial<AppConfig>, t("ui.saveFailedFor", { label: t(`ui.${SERVER_TEXT_LABEL_KEYS[key]}`) }));
    setPhase("dirty");
  };

  const commitServerText = async (key: ServerTextKey, raw: string) => {
    if (applyLockRef.current || !cfg) return;
    if (serverTextDrafts[key] === undefined && raw === String(usesRuntimeDefault(cfg, key) ? resetValues[key] ?? '' : cfg[key] ?? '')) return;
    // A displayed path omits the Windows prefix; focus changes must not persist that formatting.
    if (serverPathKeys.has(key) && serverTextDrafts[key] === undefined) return;
    if (key === "mmproj" && !projectorEditable) {
      setServerTextDrafts((current) => ({ ...current, mmproj: cfg.mmproj }));
      notify(t("ui.stopBeforeProjector"));
      return;
    }
    const value = raw.trim();
    const saved = await savePatch({ [key]: value } as Partial<AppConfig>, t("ui.saveFailedFor", { label: t(`ui.${SERVER_TEXT_LABEL_KEYS[key]}`) }));
    if (saved) {
      setServerTextDrafts((current) => {
        if (!draftStillCurrent(current[key], value)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setPhase("dirty");
    }
  };

  const serverTextValue = (key: ServerTextKey): string => {
    const inheritedValue = cfg && usesRuntimeDefault(cfg, key) ? resetValues[key] : cfg?.[key];
    const value = String(serverTextDrafts[key] ?? inheritedValue ?? "");
    return serverPathKeys.has(key) ? normalizeDisplayPath(value) : value;
  };

  const serverSelectOptions = (key: "spec_type" | "spec_draft_ngl"): readonly string[] => (
    key === "spec_type" ? SPEC_TYPE_OPTIONS : SPEC_DRAFT_NGL_OPTIONS
  );

  const serverSelectValue = (key: "spec_type" | "spec_draft_ngl"): string => {
    const value = serverTextValue(key);
    return isKnownSelectValue(value, serverSelectOptions(key)) ? value : "custom";
  };

  const selectServerText = (key: "spec_type" | "spec_draft_ngl", value: string) => {
    if (applyLockRef.current) return;
    if (value === "custom") {
      const current = serverTextValue(key);
      setServerTextDrafts((drafts) => ({
        ...drafts,
        [key]: isKnownSelectValue(current, serverSelectOptions(key)) ? "" : current,
      }));
      return;
    }
    setServerTextDrafts((drafts) => ({ ...drafts, [key]: value }));
    void commitServerText(key, value);
  };

  const updateReasoningEffort = (value: string) => {
    if (applyLockRef.current) return;
    void savePatch({ reasoning_effort: value }, t("ui.saveFailedFor", { label: t("ui.reasoningEffort") }));
    setPhase("dirty");
  };

  const updateSamplerChain = async (samplers: readonly string[]) => {
    if (applyLockRef.current || !cfg) return;
    const normalized = normalizeSamplerChain(samplers);
    await savePatch(
      (current) => {
        const chat_options = { ...current.chat_options };
        if (normalized.length > 0) chat_options.samplers = [...normalized];
        else delete chat_options.samplers;
        return { chat_options };
      },
      t("ui.saveFailedFor", { label: t("ui.samplerChain") }),
    );
  };

  const saveServerArgs = async () => {
    if (applyLockRef.current) return;
    try {
      const submitted = serverArgsDraft;
      const serverArgs = parseServerArgs(submitted);
      await store.updateConfig({ server_args: serverArgs });
      const currentDraft = serverArgsDraftRef.current;
      if (draftStillCurrent(currentDraft, submitted)) setServerArgsDirty(false);
      setAdvancedError(null);
      setPhase("dirty");
      notify(draftStillCurrent(currentDraft, submitted)
        ? t("extra.advancedSaved")
        : t("extra.advancedSavedDraftPending"));
    } catch (error) {
      setPhase("failed");
      setAdvancedError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveServerOption = async (option: ServerOption, occurrences: OptionOccurrence[]) => {
    if (applyLockRef.current || serverArgsDirty) throw new Error(serverOptionsText[locale].pending);
    // Use the save queue's current config so concurrent field saves cannot erase each other.
    if (option.flags.includes('--port')) {
      const port = occurrences.length ? Number(occurrences[0].values[0]) : 8080;
      if (occurrences.length > 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port: 1–65535');
      await store.updateConfig({ port });
    } else {
      await store.updateConfig(current => {
        const server_args = replaceServerOption(current.server_args, option, occurrences);
        // Raw edits synchronize the three primary sampling fields in withManualOverrides.
        // Reset must release those mirrors too, or the next chat would still send the old value.
        const samplingKey = option.flags.includes('--temp') ? 'temperature' : option.flags.includes('--top-p') ? 'top_p' : option.flags.includes('--top-k') ? 'top_k' : undefined;
        return occurrences.length === 0 && samplingKey ? { ...resetTuningField(current, samplingKey, resetValues), server_args } : { server_args };
      });
    }
    if (occurrences.length === 0) clearFieldDrafts(`raw-server:${option.id}`);
    setPhase('dirty');
    setChangedServerFields(fields => fields.includes(option.id) ? fields : [...fields, option.id]);
  };

  const saveChatOptions = async () => {
    if (applyLockRef.current) return;
    try {
      const submitted = chatOptionsDraft;
      const chatOptions = parseChatOptions(submitted);
      await store.updateConfig({ chat_options: chatOptions });
      const currentDraft = chatOptionsDraftRef.current;
      if (draftStillCurrent(currentDraft, submitted)) setChatOptionsDirty(false);
      setAdvancedError(null);
      notify(draftStillCurrent(currentDraft, submitted)
        ? t("extra.advancedSaved")
        : t("extra.advancedSavedDraftPending"));
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyPreset = async (name: "CPU" | "Balanced" | "Max GPU") => {
    if (applyLockRef.current) return;
    const preset =
      name === "CPU"
        ? { ngl: 0, threads: 0, flash_attn: "off" }
        : name === "Balanced"
          ? { ngl: 99, ctx_size: 8192, threads: 0, flash_attn: "auto" }
          : { ngl: 99, ctx_size: 16384, threads: 0, flash_attn: "on" };
    const saved = await savePatch(preset as Partial<AppConfig>, t("ui.saveFailedFor", { label: name }));
    if (!saved) return;
    setPhase("dirty");
    notify(t("extra.presetLoaded", { name }));
  };

  const resetDefaults = () => {
    if (applyLockRef.current || !cfg) return;
    const profile = findModelTuningProfile(cfg.active_model, cfg.active_build);
    if (!profile) {
      notify(t("ui.profileMismatch"));
      return;
    }
    const serverArgs = profile.serverArgs.join("\n");
    const chatOptions = JSON.stringify(profile.chatOptions, null, 2);
    serverArgsDraftRef.current = serverArgs;
    chatOptionsDraftRef.current = chatOptions;
    setServerArgsDraft(serverArgs);
    setChatOptionsDraft(chatOptions);
    setServerArgsDirty(false);
    setChatOptionsDirty(false);
    setAdvancedError(null);
    setServerTextDrafts({});
    void savePatch({ ...profile.defaults, mmproj: cfg.mmproj, server_args: [...profile.serverArgs], chat_options: profile.chatOptions }, t("ui.saveFailedFor", { label: profile.name }));
    setPhase("dirty");
    notify(t("ui.profileAppliedFor", { profile: profile.name, model: modelDisplayName(cfg.active_model) }));
  };

  const applyRestart = async () => {
    if (applyLockRef.current || configMutationsDisabled || !cfg) return;
    if (store.status.state !== "running") {
      setPhase("idle");
      notify(t("extra.savedNextStart"));
      return;
    }
    applyLockRef.current = true;
    try {
      await performApplyRestart(store, cfg, locale, notify, setPhase, setChangedServerFields);
    } finally {
      applyLockRef.current = false;
    }
  };


  const resetRuntimeDefaults = async (key?: string) => {
    if (applyLockRef.current || configMutationsDisabled || !cfg) return;
    applyLockRef.current = true;
    setResetting(true);
    try {
      const saved = await store.updateConfig((current) => key ? resetTuningField(current, key, resetValues) : resetAllTuning(resetValues));
      // Clear only the reset field's drafts. Unrelated unsaved text remains intact.
      clearFieldDrafts(key);
      if (!key || !serverArgsDirty) {
        const text = saved.server_args.join("\n");
        serverArgsDraftRef.current = text; setServerArgsDraft(text); setServerArgsDirty(false);
      }
      if (!key || !chatOptionsDirty) {
        const text = JSON.stringify(saved.chat_options, null, 2);
        chatOptionsDraftRef.current = text; setChatOptionsDraft(text); setChatOptionsDirty(false);
      }
      setAdvancedError(null);
      // Even a request reset can remove a raw server-side sampling override.
      setPhase("dirty");
      setChangedServerFields((fields) => [...new Set([...fields, key ?? t("ui.runtimeDefaultsTitle")])]);
      notify(t("ui.runtimeDefaultsSaved"));
    } catch (error) {
      setPhase("failed");
      notify(t("ui.runtimeDefaultsFailed") + ": " + (error instanceof Error ? error.message : String(error)));
    } finally {
      applyLockRef.current = false;
      setResetting(false);
    }
  };

  return {
    cfg, locale, phase, setPhase, flash, notify, dismissFlash, modelProfileName, resetRuntimeDefaults,
    serverArgsDraft, setServerArgsDraft, chatOptionsDraft, setChatOptionsDraft,
    serverArgsDirty, setServerArgsDirty, chatOptionsDirty, setChatOptionsDirty,
    advancedError, setAdvancedError,
    numericDrafts, setNumericDrafts, chatOptionDrafts, setChatOptionDrafts,
    chatOptionSelectModes, setChatOptionSelectModes, serverTextDrafts, setServerTextDrafts,
    changedServerFields, pendingBulkChange, setPendingBulkChange,
    serverArgsDraftRef, chatOptionsDraftRef,
    projectorEditable, configMutationsDisabled, relationWarnings, numericFieldLabel,
    commitNumeric, commitChatOption, updateFlash, updateServerText, commitServerText,
    serverTextValue, serverSelectOptions, serverSelectValue, selectServerText,
    updateReasoningEffort, updateSamplerChain, saveServerArgs, saveServerOption, saveChatOptions, applyPreset, resetDefaults, applyRestart,
  };
}
