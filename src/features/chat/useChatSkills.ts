import { useCallback, useEffect, useRef, useState } from "react";
import { getChatPersonalization, PERSONALIZATION_CHANGED_EVENT, type ChatSkill } from "../../shared/api/personalization";
import { isNativeRuntimeAvailable } from "../../shared/api/transport";
import { isSafeSkillId } from "./chatPersonalization";

/**
 * Composer state for the manual skill picker. The catalog shown here is only
 * for choosing; every send reloads its own snapshot, so a stale list can never
 * inject an outdated skill body.
 */
export function useChatSkills() {
  const [catalog, setCatalog] = useState<ChatSkill[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const requestRef = useRef(0);
  const loadedRef = useRef(false);
  const native = isNativeRuntimeAvailable();

  const refreshSkills = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const context = await getChatPersonalization();
      if (request !== requestRef.current) return;
      setCatalog(context.skills.filter((skill) => isSafeSkillId(skill.id)));
      setWarnings(context.warnings);
      setLoadError(null);
      loadedRef.current = true;
      setLoaded(true);
    } catch (caught) {
      if (request !== requestRef.current) return;
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onChanged = () => { if (loadedRef.current) void refreshSkills(); };
    window.addEventListener(PERSONALIZATION_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(PERSONALIZATION_CHANGED_EVENT, onChanged);
      // Responses that arrive after unmount are ignored.
      requestRef.current += 1;
    };
  }, [refreshSkills]);

  const toggleSkill = useCallback((id: string) => {
    setSelectedSkillIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);
  const clearSelectedSkills = useCallback(() => setSelectedSkillIds([]), []);
  const selectedSkills = selectedSkillIds.map((id) => catalog.find((skill) => skill.id === id) ?? { id, name: id, description: "", source: "aiolm" as const, path: "" });

  return {
    native, catalog, warnings, loadError, loading, loaded,
    selectedSkillIds, selectedSkills, toggleSkill, clearSelectedSkills, refreshSkills,
  };
}
