/**
 * Разбор опубликованного курса. Возвращает null, если данных нет.
 * Правило проекта: курс никогда не подставляется и не придумывается.
 * «-», «–», пустая строка, 0 и отрицательные значения означают «нет данных».
 */
export function parseRate(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? input : null;
  if (typeof input !== 'string') return null;
  let s = input.replace(/ /g, ' ').trim();
  // Убираем код валюты рядом с числом ("17.63 MDL").
  s = s.replace(/\s*[A-Za-z]{3}\s*$/, '').replace(/^[A-Za-z]{3}\s*/, '').trim();
  if (s === '' || /^[-–—]+$/.test(s)) return null;
  if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Округление для отображения/сравнения без накопления ошибок с плавающей точкой. */
export function round(n: number, digits = 6): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}
