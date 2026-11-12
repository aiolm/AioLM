import { memo } from 'react';
import type { ConfirmedSyntax, OptionSchema, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { RuntimeOptionSchemaFormView } from './RuntimeOptionSchemaFormView';
import { useRuntimeOptionSchemaForm } from './useRuntimeOptionSchemaForm';

export interface RuntimeOptionSchemaFormProps {
  schema: OptionSchema;
  values: Record<string, unknown>;
  scope: string[];
  disabled?: boolean;
  onChange: (next: Record<string, unknown>) => void;
  /** Embedded in settings: fields only; validation and preview come from the host. */
  compact?: boolean;
  /** Show the complete option list without a separate expansion step. */
  showAll?: boolean;
  /** Embedded hosts can provide their own message when a category has no options. */
  showNoMatch?: boolean;
  filter?: (option: OptionSchemaDefinition) => boolean;
  readOnlyForOption?: (option: OptionSchemaDefinition) => boolean;
  inheritLabel?: (option: OptionSchemaDefinition) => string | undefined;
  hint?: (option: OptionSchemaDefinition) => string | undefined;
  onInvalid?: (key: string, invalid: boolean) => void;
  /** Message IDs from a host that validates the complete configuration. */
  validationDescriptions?: ReadonlyMap<string, string>;
  /** Saves confirmed syntax for a reviewed help option; omitted where none applies. */
  onConfirmSyntax?: (option: OptionSchemaDefinition, syntax: ConfirmedSyntax) => void;
  /** Options whose syntax may be confirmed (reviewed help options only). */
  confirmSyntaxFor?: (option: OptionSchemaDefinition) => boolean;
}

/** Generic runtime-scoped option renderer, validator and argv preview. */
export default memo(function RuntimeOptionSchemaForm(props: RuntimeOptionSchemaFormProps) {
  const controller = useRuntimeOptionSchemaForm(props);
  return <RuntimeOptionSchemaFormView controller={controller} />;
});
