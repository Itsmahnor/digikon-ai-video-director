import type { FamilyDef } from "../kit.js";
import { SCENE_1_FAMILIES } from "./scene-1.js";
import { SCENE_2_FAMILIES } from "./scene-2.js";
import { SCENE_3_FAMILIES } from "./scene-3.js";
import { SUPPORT_1_FAMILIES } from "./support-1.js";

/** Every hand-authored base family, in the order they are considered for distinctness. */
export const ALL_FAMILIES: FamilyDef[] = [...SCENE_1_FAMILIES, ...SCENE_2_FAMILIES, ...SCENE_3_FAMILIES, ...SUPPORT_1_FAMILIES];

export const familyById = (id: string) => ALL_FAMILIES.find((f) => f.id === id);
