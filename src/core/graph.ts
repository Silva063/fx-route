import type { Channel, Currency, GraphNode, Offer } from './types';

/**
 * Узел графа = (валюта, канал, счёт).
 * Для card/online деньги лежат на счёте конкретного банка, поэтому account = id банка:
 * онлайн-доллары в Victoriabank нельзя потратить в APB Online без перевода.
 * Наличные взаимозаменяемы, у них account нет.
 */
export function node(currency: Currency, channel: Channel, source: string): GraphNode {
  return channel === 'cash' ? { currency, channel } : { currency, channel, account: source };
}

export function nodeKey(n: GraphNode): string {
  return `${n.currency}:${n.channel}${n.account ? `@${n.account}` : ''}`;
}

export const offerFromNode = (o: Offer): GraphNode => node(o.from, o.channel, o.source);
export const offerToNode = (o: Offer): GraphNode => node(o.to, o.channel, o.source);
