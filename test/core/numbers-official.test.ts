import { describe, expect, it } from 'vitest';
import { parseRate } from '../../src/core/numbers';
import { officialCross } from '../../src/core/official';
import { dmyToIso, localDate } from '../../src/core/time';
import { officials } from '../helpers';

describe('parseRate', () => {
  it.each([
    ['17.6200', 17.62],
    ['17,48', 17.48],
    ['17.63 MDL', 17.63],
    ['  20.1000 ', 20.1],
    [16.3, 16.3],
  ])('%j → %s', (input, expected) => expect(parseRate(input)).toBe(expected));

  it.each([['-'], ['–'], [''], ['0.0000'], [0], [-1], ['abc'], ['1.2.3'], [null], [undefined], [NaN]])(
    '%j → нет данных',
    (input) => expect(parseRate(input)).toBeNull(),
  );
});

describe('время', () => {
  it('локальная дата в часовом поясе Кишинёва', () => {
    // 22:30 UTC 28.09 — это уже 29.09 в Кишинёве (UTC+3 летом).
    expect(localDate('2026-09-28T22:30:00Z')).toBe('2026-09-29');
    expect(localDate('2026-09-28T20:00:00Z')).toBe('2026-09-28');
  });
  it('ДД.ММ.ГГГГ → ISO', () => {
    expect(dmyToIso('28.09.2026')).toBe('2026-09-28');
    expect(dmyToIso('1.2.2026')).toBe('2026-02-01');
    expect(dmyToIso('2026-09-28')).toBeNull();
  });
});

describe('officialCross', () => {
  it('прямой курс к MDL берётся у BNM', () => {
    const r = officialCross('USD', 'MDL', officials, '2026-09-28', 'prb');
    expect(r).toMatchObject({ source: 'bnm', value: 17.7406, exactDate: true });
  });
  it('прямой курс к RUP берётся у ПРБ', () => {
    const r = officialCross('MDL', 'RUP', officials, '2026-09-28', 'bnm');
    expect(r).toMatchObject({ source: 'prb', value: 0.9075 });
  });
  it('обратное направление', () => {
    const r = officialCross('RUP', 'MDL', officials, '2026-09-28');
    expect(r!.source).toBe('prb');
    expect(r!.value).toBeCloseTo(1 / 0.9075, 10);
  });
  it('кросс через предпочитаемый источник юрисдикции', () => {
    const pmr = officialCross('EUR', 'USD', officials, '2026-09-28', 'prb')!;
    expect(pmr.source).toBe('prb');
    expect(pmr.value).toBeCloseTo(18.3508 / 16.1, 10);
    const md = officialCross('EUR', 'USD', officials, '2026-09-28', 'bnm')!;
    expect(md.source).toBe('bnm');
  });
  it('нет пары — null, курс не придумывается', () => {
    expect(officialCross('GBP', 'MDL', officials, '2026-09-28')).toBeNull();
  });
  it('берёт последний курс, действующий на дату; иначе ближайший будущий', () => {
    const sets = [
      { ...officials[1]!, validFor: '2026-09-27', rates: { USD: 16.0 } },
      { ...officials[1]!, validFor: '2026-09-29', rates: { USD: 16.2 } },
    ];
    expect(officialCross('USD', 'RUP', sets, '2026-09-28')).toMatchObject({ value: 16.0, exactDate: false });
    expect(officialCross('USD', 'RUP', sets, '2026-09-26')).toMatchObject({ value: 16.0, validFor: '2026-09-27' });
    expect(officialCross('USD', 'RUP', sets, '2026-09-29')).toMatchObject({ value: 16.2, exactDate: true });
  });
});
