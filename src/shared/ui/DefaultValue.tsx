import type { DefaultValueInfo } from '../config/defaultValueDisplay';
import './default-value.css';

/** Keep the value visible and the full source/qualification available to assistive technology. */
export default function DefaultValue({ info }: { info: DefaultValueInfo }) {
  return <span className="default-value" title={info.description}>
    <span className="default-value-number" aria-hidden="true">{info.value}</span>{' '}
    <span className="default-value-badge" aria-hidden="true">{info.badge}</span>
    <span className="sr-only">{info.description}</span>
  </span>;
}
