/**
 * Generator interface — the pluggable surface that lets new modalities
 * (image, video) layer onto the same Core (Job/Orchestrator/StateStore/
 * ProviderRegistry/OutputSanitizer) without modifying it.
 *
 * The 1st implementation is `TextGenerator` (T3.1+). Image/video generators
 * are not built here, but the modality slot is reserved so adding them does
 * not require Core changes.
 */
export {};
