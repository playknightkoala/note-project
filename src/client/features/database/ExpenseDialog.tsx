import { useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { validateView } from '@shared/database';
import type { DatabaseDto, DatabaseView, ExpenseConfig } from '@shared/database';
import { useDatabaseSchema } from '../../api/databases.ts';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

export function ExpenseDialog({ meta, view, onClose }: { meta: DatabaseDto; view: DatabaseView; onClose: () => void }) {
  const [base] = useState(() => ({ version: meta.version, config: view.config }));
  const saved = base.config.expense;
  const numeric = meta.properties.filter(p => p.type === 'number');
  const currencies = meta.properties.filter(p => p.type === 'select');
  const [amount, setAmount] = useState(saved?.amountId ?? numeric.find(p => p.name === '原幣金額')?.id ?? '');
  const [people, setPeople] = useState(saved?.peopleId ?? numeric.find(p => p.name === '分攤人數')?.id ?? '');
  const [currency, setCurrency] = useState(saved?.currencyId ?? currencies.find(p => p.name === '幣別')?.id ?? '');
  const [rateId, setRateId] = useState(saved?.rateId ?? '');
  const [rates, setRates] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(saved?.rates ?? {}).map(([id, n]) => [id, String(n)])));
  const choices = currencies.find(p => p.id === currency)?.choices ?? [];
  const rateText = (id: string, label: string) => rates[id] ?? (/^(TWD|NTD|台幣|新台幣)$/i.test(label) ? '1' : '');
  const mutation = useDatabaseSchema(meta.id);
  const [error, setError] = useState('');
  useUpdateGuard(() => { throw new Error('請先儲存或關閉費用試算設定。'); });
  const save = (enable: boolean) => {
    const config = { ...base.config };
    if (enable) {
      const expense: ExpenseConfig = { amountId: amount, peopleId: people, currencyId: currency, rates: {}, ...(rateId ? { rateId } : {}) };
      for (const choice of choices) {
        const text = rateText(choice.id, choice.label).trim();
        if (!text) continue;
        const value = Number(text);
        if (!Number.isFinite(value) || value <= 0) { setError('匯率請輸入大於零的數字。'); return; }
        expense.rates[choice.id] = value;
      }
      if (!rateId && !Object.keys(expense.rates).length) { setError('請至少設定一個幣別匯率或指定逐筆匯率欄位。'); return; }
      config.expense = expense;
      const problem = validateView(config, meta.properties);
      if (problem) { setError(problem); return; }
    } else delete config.expense;
    mutation.mutate({ action: 'view', id: view.id, version: base.version, input: { name: view.name, config } }, { onSuccess: onClose });
  };
  const options = numeric.map(p => ({ value: p.id, label: p.name }));
  return <Modal opened onClose={() => { if (!mutation.isPending) onClose(); }} title="費用試算設定">
    <Stack><Text size="sm">每人台幣 ＝ 原幣金額 ÷ 每台幣可換的原幣 ÷ 分攤人數，四捨五入到元。</Text>
      <Select label="原幣金額欄位" data={options} value={amount || null} onChange={v => setAmount(v ?? '')} />
      <Select label="分攤人數欄位" data={options} value={people || null} onChange={v => setPeople(v ?? '')} />
      <Select label="幣別欄位" data={currencies.map(p => ({ value: p.id, label: p.name }))} value={currency || null} onChange={v => setCurrency(v ?? '')} />
      {choices.map(choice => <TextInput key={choice.id} inputMode="decimal" label={`每 NT$1 可換多少 ${choice.label}`} value={rateText(choice.id, choice.label)}
        onChange={e => { const text = e.currentTarget.value; setRates(current => ({ ...current, [choice.id]: text })); }} />)}
      <Select label="逐筆匯率欄位（選填）" placeholder="使用幣別匯率" clearable data={options} value={rateId || null} onChange={v => setRateId(v ?? '')} description="有填逐筆匯率時優先採用，留白沿用幣別匯率。" />
      {error && <Alert color="red">{error}</Alert>}{mutation.error && <Alert color="red">{errorText(mutation.error)}</Alert>}
      <Group justify="space-between">{saved && <Button variant="subtle" disabled={mutation.isPending} onClick={() => save(false)}>停用試算</Button>}
        <Button disabled={!amount || !people || !currency} loading={mutation.isPending} onClick={() => save(true)}>儲存試算設定</Button></Group>
    </Stack>
  </Modal>;
}
