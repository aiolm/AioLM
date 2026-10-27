import { useId } from 'react';
import type { CommandLayout } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeCommandCopy } from '../../shared/i18n/runtimeCommandCopy';
import { CustomSelect } from '../../shared/ui/CustomSelect';

/** Token roles are explicit adapter data, never inferred from equal text. */
export default function RuntimeCommandLayout({ prefix, value, disabled, onChange }: {
  prefix: string[]; value?: CommandLayout | null; disabled: boolean;
  onChange: (layout: CommandLayout | undefined) => void;
}) {
  const id = useId();
  const { locale } = useI18n();
  const copy = runtimeCommandCopy[locale];
  return <fieldset>
    <legend>{copy.title}</legend>
    <label htmlFor={`${id}-enable`}><input id={`${id}-enable`} type="checkbox" checked={!!value} disabled={disabled}
      onChange={event => onChange(event.target.checked ? { version: 1, subcommands: [], options: [] } : undefined)} />{copy.enable}</label>
    <p className="app-section-hint">{copy.hint}</p>
    {value && <ol className="list-decimal pl-5">{prefix.map((token, index) => {
      const option = value.options.find(option => option.index === index);
      const owner = value.options.find(option => option.index < index && index <= option.index + option.values);
      const role = option ? 'option' : value.subcommands.includes(index) ? 'command' : 'literal';
      return <li key={index}>
        <p>{copy.token} {index + 1}: <code className="break-all">{token}</code></p>
        {owner ? <p>{copy.value} {owner.index + 1}</p> : <>
          <label htmlFor={`${id}-${index}-role`}>{copy.role} {index + 1}</label>
          <CustomSelect id={`${id}-${index}-role`} value={role} disabled={disabled}
            options={[{ value: 'literal', label: copy.literal }, { value: 'option', label: copy.option }, { value: 'command', label: copy.command }]}
            onChange={role => onChange({ ...value,
              subcommands: [...value.subcommands.filter(i => i !== index), ...(role === 'command' ? [index] : [])].sort((a, b) => a - b),
              options: [...value.options.filter(o => o.index !== index), ...(role === 'option' ? [{ index, values: 0 }] : [])],
            })} />
          {option && <label htmlFor={`${id}-${index}-values`}>{copy.count} {index + 1}
            <input id={`${id}-${index}-values`} type="number" min={0} max={128} step={1} value={option.values} disabled={disabled} className="app-input"
              onChange={event => {
                const count = Number(event.target.value);
                if (Number.isInteger(count) && count >= 0 && count <= 128) onChange({ ...value,
                  options: value.options.map(o => o.index === index ? { ...o, values: count } : o),
                });
              }} />
          </label>}
        </>}
      </li>;
    })}</ol>}
  </fieldset>;
}
