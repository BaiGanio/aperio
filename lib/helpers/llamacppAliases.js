// Stable router aliases for Aperio-managed llama.cpp presets. Raw Hugging Face
// repo section names collide with llama-server's auto-discovered cache presets;
// the router can then ignore Aperio's ctx-size and OOM during inference.
export const LLAMACPP_MAIN_ALIAS = "aperio-main";
export const LLAMACPP_VLM_ALIAS = "aperio-vlm";
