import { DomainError } from "@wise-biz/errors";

export const NAME_MAX = 200;
export const MAX_CHILDREN = 20;

export interface Item {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Child {
  readonly id: string;
  readonly tenantId: string;
  readonly itemId: string;
  readonly label: string;
  readonly createdAt: Date;
}

export interface NewItemInput {
  readonly name: string;
  readonly children?: readonly string[] | undefined;
}

/** Injected, so the rule stays pure and testable. */
export interface NewItemDeps {
  readonly tenantId: string;
  readonly nextId: () => string;
  readonly now: Date;
}

function trimmed(path: string, raw: string): string {
  const value = raw.trim();
  if (value.length < 1 || value.length > NAME_MAX) {
    throw new DomainError("VALIDATION_FAILED", `${path} must be 1-${String(NAME_MAX)} characters`, {
      fieldErrors: [{ path, message: `must be 1-${String(NAME_MAX)} characters after trimming` }],
    });
  }
  return value;
}

/** Creation rule: name and labels trimmed to 1-200 chars, at most 20 children. */
export function newItem(input: NewItemInput, deps: NewItemDeps): { item: Item; children: Child[] } {
  const labels = input.children ?? [];
  if (labels.length > MAX_CHILDREN) {
    throw new DomainError("VALIDATION_FAILED", `at most ${String(MAX_CHILDREN)} children`, {
      fieldErrors: [{ path: "children", message: `at most ${String(MAX_CHILDREN)} children` }],
    });
  }
  const item: Item = {
    id: deps.nextId(),
    tenantId: deps.tenantId,
    name: trimmed("name", input.name),
    createdAt: deps.now,
  };
  const children = labels.map((label, i): Child => ({
    id: deps.nextId(),
    tenantId: deps.tenantId,
    itemId: item.id,
    label: trimmed(`children.${String(i)}`, label),
    createdAt: deps.now,
  }));
  return { item, children };
}
