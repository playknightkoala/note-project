import { Checkbox, MultiSelect, Select, TextInput } from '@mantine/core';
import { DateInput } from '@mantine/dates';
import 'dayjs/locale/zh-tw';
import type { CellValue, DatabaseProperty, PropertyChoice } from '@shared/database';

export function ChoiceTag({ choice }: { choice: PropertyChoice }) {
  return <span className="choice-tag" data-color={choice.color}>{choice.label}</span>;
}
export function CellValueInput({ property, value, onChange, label, autoFocus = false }: {
  property: DatabaseProperty | null; value: CellValue; onChange: (value: CellValue) => void; label: string; autoFocus?: boolean;
}) {
  const common = { label, autoFocus, 'data-autofocus': autoFocus || undefined };
  if (!property || property.type === 'text' || property.type === 'url') return <TextInput {...common} maxLength={property ? 2000 : 500} value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.currentTarget.value || null)} placeholder={property?.type === 'url' ? 'https://…' : '留空以清除'} />;
  // Preserve incomplete input on blur; formatted number controls can turn '-' into an empty value.
  if (property.type === 'number') return <TextInput {...common} inputMode="decimal" placeholder="例如 -12.5" value={typeof value === 'number' || typeof value === 'string' ? value : ''} onChange={event => onChange(event.currentTarget.value === '' ? null : event.currentTarget.value)} />;
  if (property.type === 'checkbox') return <Checkbox {...common} checked={value === true} onChange={e => onChange(e.currentTarget.checked)} />;
  if (property.type === 'date') return <DateInput {...common} locale="zh-tw" valueFormat="YYYY-MM-DD" placeholder="年-月-日" value={typeof value === 'string' ? value : null} onChange={onChange} clearable popoverProps={{ withinPortal: false }} />;
  const options = property.choices.map(choice => ({ value: choice.id, label: choice.label }));
  const renderOption = ({ option }: { option: { value: string } }) => <ChoiceTag choice={property.choices.find(choice => choice.id === option.value)!} />;
  if (property.type === 'multi_select') return <MultiSelect {...common} data={options} value={Array.isArray(value) ? value : []} onChange={onChange} searchable clearable renderOption={renderOption} nothingFoundMessage="沒有選項，請先編輯欄位選項。" comboboxProps={{ withinPortal: false }} />;
  return <Select {...common} data={options} value={typeof value === 'string' ? value : null} onChange={onChange} searchable clearable renderOption={renderOption} nothingFoundMessage="沒有選項，請先編輯欄位選項。" comboboxProps={{ withinPortal: false }} />;
}
export function CellDisplay({ property, value }: { property: DatabaseProperty | null; value: CellValue }) {
  if (property?.type === 'checkbox') return <span aria-label={value === true ? '已勾選' : '未勾選'}>{value === true ? '☑' : '☐'}</span>;
  if (property?.type === 'select' || property?.type === 'multi_select') {
    const ids = Array.isArray(value) ? value : value ? [value] : [];
    return <span className="choice-tags">{property.choices.filter(choice => ids.includes(choice.id)).map(choice => <ChoiceTag key={choice.id} choice={choice} />)}</span>;
  }
  return <>{value === null || value === '' ? <span className="cell-empty">{property ? '空白' : '無標題'}</span> : String(value)}</>;
}
