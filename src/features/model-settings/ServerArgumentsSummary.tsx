import type { OptionOccurrence, ServerOption } from '../../shared/config/serverOptions';

/** Group the stored argv for display without changing its order or token contents. */
function argumentRows(args: readonly string[], options: readonly ServerOption[]): OptionOccurrence[] {
  const rows: OptionOccurrence[] = [];
  const switchPattern = /^--?[a-zA-Z][\w.-]*/;
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!switchPattern.test(token)) {
      rows.push({ flag: '', values: [token] });
      continue;
    }
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    const values = equals < 0 ? [] : [token.slice(equals + 1)];
    // Custom builds may expose options absent from the catalog/help. Keep all
    // following values with an unknown option, as the profile change list does.
    const arity = options.find(option => option.flags.includes(flag))?.arity ?? Infinity;
    // Like the argument editor, preserve negative numbers and stop at the next switch.
    while (values.length < arity && index + 1 < args.length && !switchPattern.test(args[index + 1])) {
      values.push(args[++index]);
    }
    rows.push({ flag, values });
  }
  return rows;
}

export default function ServerArgumentsSummary({ args, options }: { args: readonly string[]; options: readonly ServerOption[] }) {
  return <ul className="settings-profile-arguments">
    {argumentRows(args, options).map(({ flag, values }, index) => <li key={index}>
      <code className="settings-profile-argument-key">{flag}</code>
      {values.length > 0 && <span className="settings-profile-argument-values">
        {values.map((value, valueIndex) => <code key={valueIndex}>{value}</code>)}
      </span>}
    </li>)}
  </ul>;
}
