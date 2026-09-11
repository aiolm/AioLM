/** Reserve the full width and wrapped height of every action state. Invisible
 * sizing labels are excluded from accessible names and text selection. */
export default function StableLabel({ value, labels }: { value: string; labels: string[] }) {
  const states = [...new Set([...labels, value])];
  return <span className="stable-label"><span className="sr-only">{value}</span>{states.map(label => <span key={label} className={`stable-label-size${label === value ? " is-current" : ""}`} data-label={label} aria-hidden="true" />)}</span>;
}
