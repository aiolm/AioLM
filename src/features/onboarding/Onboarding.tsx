import { useEffect, useRef, useState, type FormEvent } from 'react';
import { pickModelsDir } from '../../shared/api';
import type { AppPreferences } from '../../shared/config/preferences';
import { applyTheme, subscribeToSystemTheme, type ThemeMode } from '../../shared/config/theme';
import { localeOptions, useI18n, type Locale } from '../../shared/i18n/i18n';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { AioMark } from '../../shared/ui/AppIcons';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { onboardingCopy } from './onboardingCopy';
import './onboarding.css';

export interface SetupChoices { locale: Locale; theme: ThemeMode; modelsDir: string }

export default function Onboarding({ preferences, modelsDir, onComplete }: {
  preferences: AppPreferences;
  modelsDir: string;
  onComplete: (choices: SetupChoices) => Promise<void>;
}) {
  const { locale, setLocale, t } = useI18n();
  const copy = onboardingCopy[locale];
  const [step, setStep] = useState(0);
  const [defaultFolder] = useState(modelsDir);
  const [theme, setTheme] = useState(preferences.theme);
  const [folder, setFolder] = useState(modelsDir);
  const [saving, setSaving] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<{ kind: 'saveError' | 'folderError' | 'folderRequired'; detail?: string } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const errorMessage = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    applyTheme(theme);
    if (theme === 'system') return subscribeToSystemTheme(() => applyTheme('system'));
  }, [theme]);
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => { if (error) errorMessage.current?.focus(); }, [error]);

  const chooseFolder = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChoosing(true);
    setError(null);
    try {
      const selected = await pickModelsDir();
      if (selected) setFolder(selected);
    } catch (cause) {
      setError({ kind: 'folderError', detail: normalizeDisplayText(String(cause)) });
    } finally {
      inFlight.current = false;
      setChoosing(false);
      folderInput.current?.focus();
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    setError(null);
    if (step < 2) { setStep(step + 1); return; }
    if (!folder.trim()) { setError({ kind: 'folderRequired' }); return; }
    inFlight.current = true;
    setSaving(true);
    try {
      await onComplete({ locale, theme, modelsDir: folder.trim() });
    } catch (cause) {
      setError({ kind: 'saveError', detail: normalizeDisplayText(String(cause)) });
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return <main className="setup-page">
    <div className="setup-layout">
      <aside className="setup-intro">
        <div className="setup-brand"><AioMark /><span>AioLM</span></div>
        <h1>{copy.welcome}</h1>
        <p>{copy.intro}</p>
        <ol className="setup-progress" aria-label={copy.progress}>
          {copy.steps.map((label, index) => <li key={index} aria-current={index === step ? 'step' : undefined} data-complete={index < step}>
            <span className="setup-step-number" aria-hidden="true">{index < step ? '✓' : index + 1}</span><span>{label}</span>
          </li>)}
        </ol>
        <p className="setup-later">{copy.later}</p>
      </aside>
      <form className="setup-form" onSubmit={event => { void submit(event); }} aria-labelledby="setup-heading" aria-busy={saving}>
        <header className="setup-heading">
          <span className="app-eyebrow">{String(step + 1).padStart(2, '0')} / 03</span>
          <h2 id="setup-heading" ref={heading} tabIndex={-1}>{copy.titles[step]}</h2>
          <p>{copy.descriptions[step]}</p>
        </header>
        <div className="setup-content">
          {step === 0 && <fieldset className="setup-options setup-languages">
            <legend className="sr-only">{copy.steps[0]}</legend>
            {[...localeOptions].sort((a, b) => Number(b.value === 'en') - Number(a.value === 'en')).map(option => <label key={option.value} className={`app-list-row setup-choice${locale === option.value ? ' is-selected' : ''}`}>
              <input type="radio" name="setup-language" value={option.value} checked={locale === option.value} onChange={() => setLocale(option.value)} />
              <span lang={option.value}>{option.label}</span>
            </label>)}
          </fieldset>}
          {step === 1 && <fieldset className="setup-options setup-themes">
            <legend className="sr-only">{copy.steps[1]}</legend>
            {(['light', 'dark', 'system'] as const).map(mode => <label key={mode} className={`app-list-row setup-choice setup-theme-choice${theme === mode ? ' is-selected' : ''}`}>
              <span className={`setup-preview setup-preview--${mode}`} aria-hidden="true"><span className="setup-preview-sidebar" /><span className="setup-preview-workspace"><i /><i /><i /></span></span>
              <span className="setup-theme-label"><input type="radio" name="setup-theme" value={mode} checked={theme === mode} onChange={() => setTheme(mode)} /><span>{t(`theme.${mode}`)}</span></span>
              <small>{copy[`${mode}Hint`]}</small>
            </label>)}
          </fieldset>}
          {step === 2 && <div className="setup-folder">
            <label htmlFor="setup-folder">{copy.folderLabel}</label>
            <p id="setup-folder-hint">{copy.folderHint}</p>
            <input ref={folderInput} id="setup-folder" className="app-input app-mono" name="models-directory" value={folder} readOnly aria-describedby="setup-folder-hint" />
            <div className="setup-folder-actions">
              <button type="button" className="app-button app-button--secondary app-button--lg" disabled={saving || choosing} data-icon="folder" onClick={() => { void chooseFolder(); }}>{choosing ? copy.choosing : copy.browse}</button>
              {folder !== defaultFolder && <button type="button" className="app-button app-button--secondary app-button--lg" disabled={saving || choosing} data-icon="reset" onClick={() => { setFolder(defaultFolder); setError(null); folderInput.current?.focus(); }}>{copy.defaultFolder}</button>}
            </div>
            <div className="setup-folder-note"><strong>{copy.noModels}</strong><p>{copy.noModelsHint}</p></div>
          </div>}
        </div>
        {error && <div ref={errorMessage} className="setup-error" tabIndex={-1}>
          <FeedbackBanner tone="error" title={error.detail ? copy[error.kind] : undefined}>{error.detail ?? copy[error.kind]}</FeedbackBanner>
        </div>}
        <footer className="setup-footer">
          {step > 0 && <button type="button" className="app-button app-button--secondary app-button--lg" disabled={saving || choosing} data-icon="back" onClick={() => { setError(null); setStep(step - 1); }}>{copy.back}</button>}
          <button type="submit" className="app-button app-button--primary app-button--lg" disabled={saving || choosing}>{saving ? copy.saving : step === 2 ? copy.finish : copy.next}<span aria-hidden="true"> →</span></button>
        </footer>
      </form>
    </div>
  </main>;
}
