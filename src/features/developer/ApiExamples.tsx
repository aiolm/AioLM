import { useState } from 'react';
import { useI18n } from '../../shared/i18n/i18n';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { apiServerCopy } from './apiServerCopy';

export type ApiFormat = 'openai' | 'anthropic';
type Language = 'curl' | 'python' | 'javascript';

const endpoints = {
  openai: [
    ['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/responses'],
    ['GET / DELETE', '/v1/responses/<id>'], ['POST', '/v1/completions'], ['POST', '/v1/embeddings'],
  ],
  anthropic: [['POST', '/v1/messages']],
};

function example(baseUrl: string, format: ApiFormat, language: Language): string {
  const anthropic = format === 'anthropic';
  const root = baseUrl.replace(/\/v1\/?$/, '');
  if (language === 'curl') {
    const url = anthropic ? `${root}/v1/messages` : `${baseUrl}/chat/completions`;
    const auth = anthropic
      ? '  -H "x-api-key: <LOCAL_API_KEY>" \\\n  -H "anthropic-version: 2023-06-01"'
      : '  -H "Authorization: Bearer <LOCAL_API_KEY>"';
    return `curl ${url} \\\n${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`;
  }
  if (language === 'python') return anthropic
    ? `from anthropic import Anthropic\n\nclient = Anthropic(base_url="${root}", api_key="<LOCAL_API_KEY>")\nresponse = client.messages.create(\n    model="<MODEL_ID>",\n    max_tokens=256,\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.content)`
    : `from openai import OpenAI\n\nclient = OpenAI(base_url="${baseUrl}", api_key="<LOCAL_API_KEY>")\nresponse = client.chat.completions.create(\n    model="<MODEL_ID>",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`;
  return anthropic
    ? `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({\n  baseURL: "${root}",\n  apiKey: "<LOCAL_API_KEY>",\n});\nconst response = await client.messages.create({\n  model: "<MODEL_ID>",\n  max_tokens: 256,\n  messages: [{ role: "user", content: "Hello" }],\n});\nconsole.log(response.content);`
    : `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${baseUrl}",\n  apiKey: "<LOCAL_API_KEY>",\n});\nconst response = await client.chat.completions.create({\n  model: "<MODEL_ID>",\n  messages: [{ role: "user", content: "Hello" }],\n});\nconsole.log(response.choices[0].message.content);`;
}

export default function ApiExamples({ baseUrl, format, onCopy, copied }: {
  baseUrl: string; format: ApiFormat; onCopy: (text: string) => void; copied: boolean;
}) {
  const { t, locale } = useI18n();
  const copy = apiServerCopy[locale];
  const [language, setLanguage] = useState<Language>('curl');
  const snippet = example(baseUrl, format, language);
  return <details className="api-disclosure">
    <summary>{copy.examples}</summary>
    <div className="api-disclosure-content">
      <div className="api-example-toolbar">
        <label htmlFor="api-example-language">{copy.language}</label>
        <CustomSelect<Language> id="api-example-language" value={language} onChange={setLanguage}
          options={[{ value: 'curl', label: 'cURL' }, { value: 'python', label: 'Python' }, { value: 'javascript', label: 'JavaScript' }]} />
        <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="copy" onClick={() => onCopy(snippet)}>{copied ? t('panel.copied') : copy.copyExample}</button>
      </div>
      <p className="api-hint">{copy.exampleHint}</p>
      <pre tabIndex={0} aria-label={copy.examples} className="api-code"><code>{snippet}</code></pre>
      <table className="api-endpoints"><caption className="sr-only">{copy.examples}</caption>
        <thead><tr><th scope="col">{copy.method}</th><th scope="col">{copy.endpoint}</th></tr></thead>
        <tbody>{endpoints[format].map(([method, path]) => <tr key={path}><td>{method}</td><td><code>{path}</code></td></tr>)}</tbody>
      </table>
    </div>
  </details>;
}
