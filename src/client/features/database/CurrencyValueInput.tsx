import { useState } from 'react';
import { TextInput } from '@mantine/core';
import { convertCurrency } from '@shared/database';
import type { CellValue, CurrencyConversion } from '@shared/database';

export const currencyAmountFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });

export function CurrencyValueInput({ conversion, value, onChange }: {
  conversion: CurrencyConversion; value: CellValue; onChange: (value: CellValue) => void;
}) {
  const [input, setInput] = useState<{ reverse: boolean; text: string }>();
  const { from, to, rate } = conversion;
  const equivalent = typeof value === 'number' ? convertCurrency(value, rate) : null;
  const change = (text: string, reverse: boolean) => {
    setInput({ reverse, text });
    if (!text.trim()) { onChange(null); return; }
    const amount = Number(text);
    const base = reverse ? amount / rate : amount;
    onChange(convertCurrency(base, rate) === null ? text : base);
  };
  return <>
    <TextInput label={`${from} 金額`} data-autofocus inputMode="decimal"
      value={input && !input.reverse ? input.text : typeof value === 'number' ? String(value) : ''}
      onChange={event => change(event.currentTarget.value, false)} />
    <TextInput label={`${to} 金額`} inputMode="decimal"
      value={input?.reverse ? input.text : equivalent === null ? '' : String(Number(equivalent.toPrecision(15)))}
      onChange={event => change(event.currentTarget.value, true)} />
  </>;
}
