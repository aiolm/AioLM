import type { DefaultValueInfo } from '../config/defaultValueDisplay';
import './default-value.css';
import Badge from './Badge';

/** Keep the value visible and the full source/qualification available to assistive technology. */
export default function DefaultValue({ info }: { info: DefaultValueInfo }) {
  return <span className="default-value" title={info.description}>
    <span className="default-value-number" aria-hidden="true">{info.value}</span>{' '}
    <Badge aria-hidden="true">{info.badge}</Badge>
    <span className="sr-only">{info.description}</span>
  </span>;
}
