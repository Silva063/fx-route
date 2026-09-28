import type { Adapter } from '../adapter';
import { htmlTablesAdapter } from './declarative';
import { comertbankAdapter, eurocreditbankAdapter, fincombankAdapter, micbAdapter, victoriabankAdapter } from './moldova';
import { bnmAdapter, prbAdapter } from './official';
import { agroprombankAdapter, prisbankAdapter } from './pmr';

/**
 * Реестр адаптеров: имя (поле `adapter` в config/sources.json) → реализация.
 * `html-tables` — декларативный адаптер: источник целиком описывается параметрами в конфиге.
 */
export const adapters: Record<string, Adapter> = {
  'html-tables': htmlTablesAdapter,
  bnm: bnmAdapter,
  prb: prbAdapter,
  agroprombank: agroprombankAdapter,
  prisbank: prisbankAdapter,
  victoriabank: victoriabankAdapter,
  micb: micbAdapter,
  fincombank: fincombankAdapter,
  eurocreditbank: eurocreditbankAdapter,
  comertbank: comertbankAdapter,
};
