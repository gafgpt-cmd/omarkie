export interface ConflictCopy { base: string; app: "syncthing" | "omarkie"; at: string; origin: string }
export function conflictCopy(name: string): ConflictCopy | null;
export function conflictName(name: string, origin: string, date?: Date): string;
export function copiesOf<T extends { path: string; name: string }>(notePath: string, entries: T[]): (T & { copy: ConflictCopy })[];
