export const DEEPSEEK_V4_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
  "deepseek-ai/deepseek-v4-pro",
]);

export type MultimodalMode = "default" | "on" | "off";

export function defaultsToThinkingMode(model: string): boolean {
  return DEEPSEEK_V4_MODELS.has(model);
}

/**
 * Whether the given model supports multimodal (image) content.
 *
 * `mode` is the resolved `multimodal` configuration:
 * - `"on"`: always treat the model as multimodal.
 * - `"off"`: always treat the model as non-multimodal.
 * - `"default"` (or omitted): infer from whether the model name contains `-vision`.
 */
export function supportsMultimodal(model: string, mode: MultimodalMode = "default"): boolean {
  if (mode === "on") {
    return true;
  }
  if (mode === "off") {
    return false;
  }
  return model.includes("-vision");
}
