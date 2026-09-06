import type { Match } from "./season";

type Build = Match["builds"][number];
type Set = NonNullable<Build["sets"]>[number];

function setFields(set: Set) {
  return {
    Species: set.species,
    Item: set.item || "None",
    Ability: set.ability,
    Nature: set.nature,
    Moves: [...set.moves].sort().join(", "),
    EVs:
      Object.entries(set.evs)
        .filter(([, value]) => value !== 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stat, value]) => `${stat} ${value}`)
        .join(" / ") || "None",
  };
}

export function buildChanges(previous: Build, current: Build) {
  const added = current.prepared.filter((id) => !previous.prepared.includes(id));
  const removed = previous.prepared.filter((id) => !current.prepared.includes(id));
  const sets =
    current.sets?.flatMap((set, index) => {
      const draftId = current.prepared[index];
      if (!draftId) throw new Error("registered set has no draft ID");
      const before = previous.sets?.[previous.prepared.indexOf(draftId)];
      if (!before) return [];
      const oldFields = setFields(before);
      const newFields = setFields(set);
      const fields = ["Species", "Item", "Ability", "Nature", "Moves", "EVs"] satisfies Array<
        keyof typeof oldFields
      >;
      return fields.flatMap((field) =>
        oldFields[field] === newFields[field]
          ? []
          : [{ species: set.species, field, before: oldFields[field], after: newFields[field] }],
      );
    }) ?? [];
  return { added, removed, sets, setsVisible: previous.sets !== null && current.sets !== null };
}
