import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import DiagnosticDetails, { summarizeDiagnostic } from '../../shared/ui/DiagnosticDetails';
import AdapterSetupPanel from './AdapterSetupPanel';
import {
  EntrypointBindingsStep,
  EntrypointEntryStep,
  EntrypointHelpStep,
  EntrypointReviewStep,
} from './EntrypointRegistrationSteps';
import { useEntrypointRegistrationController } from './useEntrypointRegistrationController';
import type { EntrypointRegistrationProps } from './entrypointRegistrationTypes';

/** Executable/entry point → help → explicit bindings, protocol and probe →
 * reviewed manifest → register. Nothing is inferred; a fresh model probe
 * after registration decides Ready. */
export default function EntrypointRegistration(props: EntrypointRegistrationProps) {
  const controller = useEntrypointRegistrationController(props);
  const {
    id, copy, step, steps, disabled, busy, setBusy, onPrepared, locked,
    canContinue, previous, next, review, helpPending, error,
  } = controller;
  return (
    <section className="app-card app-card--tight mb-4 entrypoint-registration" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} ref={props.titleRef} tabIndex={-1} className="app-section-title">{copy.title}</h3>
      <p className="app-section-hint">{copy.hint}</p>
      <nav aria-label={copy.steps}>
        <ol className="entrypoint-steps">
          {steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}>{label}</li>)}
        </ol>
      </nav>
      <div hidden={step !== 0}><AdapterSetupPanel disabled={disabled} onBusyChange={setBusy} onPrepared={onPrepared} /></div>
      {locked && !busy && <p className="app-section-hint">{copy.locked}</p>}
      <form action="#" method="POST" onSubmit={event => event.preventDefault()}>
        {step === 0 && <EntrypointEntryStep controller={controller} />}
        {step === 1 && <EntrypointHelpStep controller={controller} />}
        {step === 2 && <EntrypointBindingsStep controller={controller} />}
        {step === 3 && <EntrypointReviewStep controller={controller} />}
        <div className="app-page-actions entrypoint-footer">
          {step > 0 && <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={previous}>{copy.previous}</button>}
          {step < 2 && <button type="button" className="app-button app-button--secondary" disabled={disabled || !canContinue} onClick={next}>{copy.next}</button>}
          {step === 2 && <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => void review()}>{copy.review}</button>}
        </div>
      </form>
      {helpPending ? <FeedbackBanner tone="warning">
        <p>{copy.helpPending}</p>
        {error && <DiagnosticDetails summary={summarizeDiagnostic(error)} detail={error} />}
      </FeedbackBanner> : error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    </section>
  );
}
