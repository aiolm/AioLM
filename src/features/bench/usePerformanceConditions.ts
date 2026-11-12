import { useEffect, useState } from 'react';
import * as api from '../../shared/api/index';
import { CORPORA } from './performanceBenchConfig';

/** Serving workload selection and the admission tied to its exact configuration. */
export function usePerformanceConditions(targetConfig: api.AppConfig | null, active: boolean, busy: boolean) {
  const [promptBytes, setPromptBytes] = useState([4096, 16384]);
  const [concurrencies, setConcurrencies] = useState([1, 2, 4]);
  const [warmup, setWarmup] = useState(true);
  const [outputTokens, setOutputTokens] = useState(1024);
  const [repetitions, setRepetitions] = useState(1);
  const [corpus, setCorpus] = useState<(typeof CORPORA)[number]>("code_python");
  const [admissionReply, setAdmissionReply] = useState<{ key: string; value: api.PerformanceBenchmarkAdmission } | null>(null);
  const [admissionRevision, setAdmissionRevision] = useState(0);
  const valid = promptBytes.length > 0 && concurrencies.length > 0 && promptBytes.length * concurrencies.length <= 64;
  const total = promptBytes.length * concurrencies.length * repetitions;
  const admissionKey = targetConfig ? JSON.stringify({ revision: admissionRevision, cfg: targetConfig, request: {
    run_id: 'admission', method: { id: 'openai-chat-serving', version: 2 }, context_profile: corpus,
    prompt_bytes: promptBytes, max_output_tokens: outputTokens, concurrencies, repetitions, warmup, request_usage: true,
  } }) : '';
  const admission = admissionReply?.key === admissionKey ? admissionReply.value : null;

  useEffect(() => {
    if (!admissionKey || !active || busy) return;
    setAdmissionReply(null);
    let disposed = false;
    const { cfg, request } = JSON.parse(admissionKey) as { cfg: api.AppConfig; request: api.PerformanceBenchmarkRequest };
    void api.performanceBenchAdmission(cfg, request).then(value => {
      if (!disposed) setAdmissionReply({ key: admissionKey, value });
    }).catch(cause => {
      if (!disposed) setAdmissionReply({ key: admissionKey, value: {
        status: 'unknown', reason: 'configuration', detail: cause instanceof Error ? cause.message : String(cause),
      } });
    });
    return () => { disposed = true; };
  }, [admissionKey, active, busy]);

  const toggle = (value: number, current: number[], update: (values: number[]) => void) => update(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  return { promptBytes, setPromptBytes, concurrencies, setConcurrencies, warmup, setWarmup,
    outputTokens, setOutputTokens, repetitions, setRepetitions, corpus, setCorpus,
    valid, total, admission, setAdmissionRevision, toggle };
}
