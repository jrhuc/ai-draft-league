import { z } from "zod";

import type { JsonObject, JsonValue, ToolDefinition } from "./types.js";

const object = z.record(z.string(), z.json());
const schemaNode = z.object({
  properties: object.optional(),
  additionalProperties: z.json().optional(),
  items: z.json().optional(),
});

function undeclaredFields(schema: JsonValue, value: JsonValue, path = ""): string[] {
  const node = schemaNode.safeParse(schema);
  if (!node.success) return [];
  const { properties, additionalProperties, items } = node.data;
  if (Array.isArray(value))
    return items === undefined
      ? []
      : value.flatMap((item, index) => undeclaredFields(items, item, `${path}[${index}]`));
  const record = object.safeParse(value);
  if (!record.success || !properties) return [];
  return Object.entries(record.data).flatMap(([key, child]) => {
    const declared = properties[key];
    const field = path ? `${path}.${key}` : key;
    if (declared === undefined) return additionalProperties === false ? [field] : [];
    return undeclaredFields(declared, child, field);
  });
}

export function rejectUndeclared(tool: ToolDefinition, args: JsonObject): void {
  const undeclared = undeclaredFields(tool.parameters, args);
  if (!undeclared.length) return;
  const declared = Object.keys(schemaNode.parse(tool.parameters).properties ?? {});
  throw new Error(
    `${tool.name} has no field ${undeclared.map((field) => JSON.stringify(field)).join(", ")}; nothing was accepted. Its fields are ${declared.join(", ")}.`,
  );
}

export function withoutClosedObjects(schema: JsonValue): JsonValue {
  if (Array.isArray(schema)) return schema.map(withoutClosedObjects);
  const record = object.safeParse(schema);
  if (!record.success) return schema;
  return Object.fromEntries(
    Object.entries(record.data)
      .filter(([key, value]) => key !== "additionalProperties" || value !== false)
      .map(([key, value]) => [key, withoutClosedObjects(value)]),
  );
}
