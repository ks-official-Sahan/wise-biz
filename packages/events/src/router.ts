import { eventKey } from "./message.ts";

import type { ConsumerDefinition } from "./consumer.ts";

/** O(1) event -> consumers lookup: exact `type@vN` map plus `type@*` map. */
export class ConsumerRouter {
  private readonly names = new Set<string>();
  private readonly exact = new Map<string, ConsumerDefinition[]>();
  private readonly wild = new Map<string, ConsumerDefinition[]>();

  add(consumer: ConsumerDefinition): void {
    if (this.names.has(consumer.name)) throw new Error(`duplicate consumer: ${consumer.name}`);
    this.names.add(consumer.name);
    for (const pattern of new Set(consumer.events)) {
      const at = pattern.lastIndexOf("@");
      const target = pattern.endsWith("@*") ? this.wild : this.exact;
      const k = target === this.wild ? pattern.slice(0, at) : pattern;
      const list = target.get(k);
      if (list) {
        if (!list.includes(consumer)) list.push(consumer);
      } else target.set(k, [consumer]);
    }
  }

  match(type: string, version: number): readonly ConsumerDefinition[] {
    const a = this.exact.get(eventKey(type, version));
    const b = this.wild.get(type);
    if (!a) return b ?? [];
    if (!b) return a;
    return [...new Set([...a, ...b])];
  }
}
